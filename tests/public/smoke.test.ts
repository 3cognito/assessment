import crypto from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { createDatabase, seedDatabase, type AppDatabase } from "../../src/server/db.js";
import { processOutbox } from "../../src/server/outbox.js";
import { FakeProvider } from "../../src/server/provider.js";

function providerSignature(body: string, secret = "local-webhook-secret") {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("starter smoke checks", () => {
  let db: AppDatabase;
  let provider: FakeProvider;

  beforeEach(() => {
    db = createDatabase();
    seedDatabase(db);
    provider = new FakeProvider();
  });

  afterEach(() => db.close());

  it("starts and reports health", async () => {
    const response = await request(createApp({ db, provider })).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it("requires a demo identity on user routes", async () => {
    const response = await request(createApp({ db, provider })).get("/api/accounts");
    expect(response.status).toBe(401);
  });

  it("can create and list a transfer on the happy path", async () => {
    const app = createApp({ db, provider });
    const created = await request(app)
      .post("/api/transfers")
      .set("x-demo-user", "user-a")
      .set("Idempotency-Key", "public-test-1")
      .send({ debitAccountId: "acc-a", destinationAccount: "0123456789", amount: 10_000 });

    expect(created.status).toBe(201);
    expect(created.body.amount).toBe(10_000);

    const listed = await request(app).get("/api/transfers").set("x-demo-user", "user-a");
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
  });

  it("returns the original transfer when an idempotency key is retried", async () => {
    const app = createApp({ db, provider });

    const first = await request(app)
      .post("/api/transfers")
      .set("x-demo-user", "user-a")
      .set("Idempotency-Key", "retry-key")
      .send({ debitAccountId: "acc-a", destinationAccount: "0123456789", amount: 400_000 });

    const retry = await request(app)
      .post("/api/transfers")
      .set("x-demo-user", "user-a")
      .set("Idempotency-Key", "retry-key")
      .send({ debitAccountId: "acc-a", destinationAccount: "0123456789", amount: 400_000 });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);

    const rows = db.prepare("SELECT * FROM transfers").all();
    expect(rows).toHaveLength(1);
  });

  it("rejects idempotency key reuse with a different request", async () => {
    const app = createApp({ db, provider });

    const first = await request(app)
      .post("/api/transfers")
      .set("x-demo-user", "user-a")
      .set("Idempotency-Key", "conflict-key")
      .send({ debitAccountId: "acc-a", destinationAccount: "0123456789", amount: 10_000 });

    const conflict = await request(app)
      .post("/api/transfers")
      .set("x-demo-user", "user-a")
      .set("Idempotency-Key", "conflict-key")
      .send({ debitAccountId: "acc-a", destinationAccount: "0123456789", amount: 20_000 });

    expect(first.status).toBe(201);
    expect(conflict.status).toBe(409);

    const rows = db.prepare("SELECT * FROM transfers").all();
    expect(rows).toHaveLength(1);
  });

  it("rejects transfers from accounts owned by another user", async () => {
    const app = createApp({ db, provider });

    const response = await request(app)
      .post("/api/transfers")
      .set("x-demo-user", "user-a")
      .set("Idempotency-Key", "forbidden-key")
      .send({ debitAccountId: "acc-b", destinationAccount: "0123456789", amount: 10_000 });

    expect(response.status).toBe(403);
    expect(db.prepare("SELECT * FROM transfers").all()).toHaveLength(0);
  });

  it("rejects invalid transfer amounts", async () => {
    const app = createApp({ db, provider });
    const amounts = [0, -1, 10.5, "10000"];

    for (const amount of amounts) {
      const response = await request(app)
        .post("/api/transfers")
        .set("x-demo-user", "user-a")
        .set("Idempotency-Key", `invalid-amount-${String(amount)}`)
        .send({ debitAccountId: "acc-a", destinationAccount: "0123456789", amount });

      expect(response.status).toBe(400);
    }

    expect(db.prepare("SELECT * FROM transfers").all()).toHaveLength(0);
  });

  it("restricts reconciliation to admins", async () => {
    const app = createApp({ db, provider });

    const response = await request(app)
      .post("/api/admin/reconcile")
      .set("x-demo-user", "user-a")
      .send({});

    expect(response.status).toBe(403);
  });

  it("rejects provider webhooks with an invalid signature", async () => {
    const app = createApp({ db, provider });

    const response = await request(app)
      .post("/api/provider/webhook")
      .set("x-provider-signature", "bad-signature")
      .send({ eventId: "evt-invalid", transferId: "missing", status: "succeeded" });

    expect(response.status).toBe(401);
  });

  it("dedupes provider webhook events", async () => {
    const app = createApp({ db, provider });

    const transfer = await request(app)
      .post("/api/transfers")
      .set("x-demo-user", "user-a")
      .set("Idempotency-Key", "webhook-key")
      .send({ debitAccountId: "acc-a", destinationAccount: "0123456789", amount: 10_000 });

    const body = JSON.stringify({
      eventId: "evt-duplicate",
      transferId: transfer.body.id,
      status: "succeeded",
    });

    const first = await request(app)
      .post("/api/provider/webhook")
      .set("Content-Type", "application/json")
      .set("x-provider-signature", providerSignature(body))
      .send(body);

    const duplicate = await request(app)
      .post("/api/provider/webhook")
      .set("Content-Type", "application/json")
      .set("x-provider-signature", providerSignature(body))
      .send(body);

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toEqual({ received: true, duplicate: true });

    expect(db.prepare("SELECT * FROM webhook_events").all()).toHaveLength(1);
    expect(
      db.prepare("SELECT transfer_id, status, applied_at, ignored_reason FROM webhook_events").get(),
    ).toMatchObject({
      transfer_id: transfer.body.id,
      status: "succeeded",
      applied_at: expect.any(String),
      ignored_reason: null,
    });
    expect(
      db.prepare("SELECT status FROM transfers WHERE id = ?").get(transfer.body.id),
    ).toMatchObject({ status: "succeeded" });
  });

  it("ignores invalid webhook state transitions", async () => {
    const app = createApp({ db, provider });

    const transfer = await request(app)
      .post("/api/transfers")
      .set("x-demo-user", "user-a")
      .set("Idempotency-Key", "late-webhook-key")
      .send({ debitAccountId: "acc-a", destinationAccount: "0123456789", amount: 10_000 });

    db.prepare("UPDATE transfers SET status = ? WHERE id = ?").run("succeeded", transfer.body.id);

    const body = JSON.stringify({
      eventId: "evt-late-failed",
      transferId: transfer.body.id,
      status: "failed",
    });

    const response = await request(app)
      .post("/api/provider/webhook")
      .set("Content-Type", "application/json")
      .set("x-provider-signature", providerSignature(body))
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, ignored: true });
    expect(
      db.prepare("SELECT status FROM transfers WHERE id = ?").get(transfer.body.id),
    ).toMatchObject({ status: "succeeded" });
    expect(
      db.prepare("SELECT applied_at, ignored_reason FROM webhook_events WHERE event_id = ?").get(
        "evt-late-failed",
      ),
    ).toMatchObject({
      applied_at: null,
      ignored_reason: "invalid transition from succeeded to failed",
    });
  });

  it("processes accepted provider instructions from the outbox", async () => {
    const app = createApp({ db, provider });

    const transfer = await request(app)
      .post("/api/transfers")
      .set("x-demo-user", "user-a")
      .set("Idempotency-Key", "outbox-accepted-key")
      .send({ debitAccountId: "acc-a", destinationAccount: "0123456789", amount: 10_000 });

    const result = await processOutbox({ db, provider });

    expect(result).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({ clientReference: transfer.body.id });
    expect(
      db.prepare("SELECT status, provider_reference FROM transfers WHERE id = ?").get(transfer.body.id),
    ).toMatchObject({
      status: "pending",
      provider_reference: `provider-${transfer.body.id}`,
    });
  });

  it("records rejected provider instructions from the outbox", async () => {
    const app = createApp({ db, provider });

    const transfer = await request(app)
      .post("/api/transfers")
      .set("x-demo-user", "user-a")
      .set("Idempotency-Key", "outbox-rejected-key")
      .send({ debitAccountId: "acc-a", destinationAccount: "0123456799", amount: 10_000 });

    const result = await processOutbox({ db, provider });

    expect(result).toBe(1);
    expect(
      db.prepare("SELECT status, provider_reference, failure_reason FROM transfers WHERE id = ?").get(
        transfer.body.id,
      ),
    ).toMatchObject({
      status: "reversed",
      provider_reference: `provider-${transfer.body.id}`,
      failure_reason: "provider rejected",
    });
    expect(db.prepare("SELECT * FROM reversals WHERE transfer_id = ?").all(transfer.body.id)).toHaveLength(
      1,
    );
    expect(db.prepare("SELECT balance_minor FROM accounts WHERE id = ?").get("acc-a")).toMatchObject({
      balance_minor: 500_000,
    });
  });

  it("records provider timeouts as uncertain", async () => {
    const app = createApp({ db, provider });

    const transfer = await request(app)
      .post("/api/transfers")
      .set("x-demo-user", "user-a")
      .set("Idempotency-Key", "outbox-uncertain-key")
      .send({ debitAccountId: "acc-a", destinationAccount: "0123456788", amount: 10_000 });

    const result = await processOutbox({ db, provider });

    expect(result).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(
      db.prepare("SELECT status, failure_reason FROM transfers WHERE id = ?").get(transfer.body.id),
    ).toMatchObject({
      status: "uncertain",
      failure_reason: "provider timeout after acceptance",
    });
  });

  it("reverses a failed provider webhook exactly once", async () => {
    const app = createApp({ db, provider });

    const transfer = await request(app)
      .post("/api/transfers")
      .set("x-demo-user", "user-a")
      .set("Idempotency-Key", "webhook-failed-key")
      .send({ debitAccountId: "acc-a", destinationAccount: "0123456789", amount: 10_000 });

    const body = JSON.stringify({
      eventId: "evt-failed",
      transferId: transfer.body.id,
      status: "failed",
    });

    const first = await request(app)
      .post("/api/provider/webhook")
      .set("Content-Type", "application/json")
      .set("x-provider-signature", providerSignature(body))
      .send(body);

    const duplicate = await request(app)
      .post("/api/provider/webhook")
      .set("Content-Type", "application/json")
      .set("x-provider-signature", providerSignature(body))
      .send(body);

    expect(first.status).toBe(200);
    expect(duplicate.body).toEqual({ received: true, duplicate: true });
    expect(
      db.prepare("SELECT status, failure_reason FROM transfers WHERE id = ?").get(transfer.body.id),
    ).toMatchObject({
      status: "reversed",
      failure_reason: "provider webhook failed",
    });
    expect(db.prepare("SELECT * FROM reversals WHERE transfer_id = ?").all(transfer.body.id)).toHaveLength(
      1,
    );
    expect(db.prepare("SELECT balance_minor FROM accounts WHERE id = ?").get("acc-a")).toMatchObject({
      balance_minor: 500_000,
    });
  });

  it("reconciles uncertain succeeded transfers", async () => {
    const app = createApp({ db, provider });

    const transfer = await request(app)
      .post("/api/transfers")
      .set("x-demo-user", "user-a")
      .set("Idempotency-Key", "reconcile-succeeded-key")
      .send({ debitAccountId: "acc-a", destinationAccount: "0123456789", amount: 10_000 });

    await processOutbox({ db, provider });
    db.prepare("UPDATE transfers SET status = ? WHERE id = ?").run("uncertain", transfer.body.id);

    const response = await request(app)
      .post("/api/admin/reconcile")
      .set("x-demo-user", "ops-admin")
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ processed: 1 });
    expect(db.prepare("SELECT status FROM transfers WHERE id = ?").get(transfer.body.id)).toMatchObject({
      status: "succeeded",
    });
    expect(db.prepare("SELECT balance_minor FROM accounts WHERE id = ?").get("acc-a")).toMatchObject({
      balance_minor: 490_000,
    });
  });

  it("reconciles uncertain failed transfers without double-crediting", async () => {
    const app = createApp({ db, provider });

    const transfer = await request(app)
      .post("/api/transfers")
      .set("x-demo-user", "user-a")
      .set("Idempotency-Key", "reconcile-failed-key")
      .send({ debitAccountId: "acc-a", destinationAccount: "0123456789", amount: 10_000 });

    await processOutbox({ db, provider });
    const providerReference = `provider-${transfer.body.id}`;
    db.prepare("UPDATE transfers SET status = ? WHERE id = ?").run("uncertain", transfer.body.id);
    provider.setStatus(providerReference, "failed");

    const first = await request(app)
      .post("/api/admin/reconcile")
      .set("x-demo-user", "ops-admin")
      .send({});
    const second = await request(app)
      .post("/api/admin/reconcile")
      .set("x-demo-user", "ops-admin")
      .send({});

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ processed: 1 });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ processed: 0 });
    expect(
      db.prepare("SELECT status, failure_reason FROM transfers WHERE id = ?").get(transfer.body.id),
    ).toMatchObject({
      status: "reversed",
      failure_reason: "provider reconciliation failed",
    });
    expect(db.prepare("SELECT * FROM reversals WHERE transfer_id = ?").all(transfer.body.id)).toHaveLength(
      1,
    );
    expect(db.prepare("SELECT balance_minor FROM accounts WHERE id = ?").get("acc-a")).toMatchObject({
      balance_minor: 500_000,
    });
  });
});
