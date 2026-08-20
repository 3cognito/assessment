import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { AppDatabase } from "./db.js";
import { systemClock, type Clock, type TransferProvider } from "./types.js";
import { hash } from "./util.js";

const TOPIC = "payment.created"; //I would save to an outbox table and have the provider call happen in the background

const transferInput = z.object({
  debitAccountId: z.string().min(1),
  destinationAccount: z.string().regex(/^\d{10}$/),
  amount: z.number().int().positive(),
});

interface AppOptions {
  db: AppDatabase;
  provider: TransferProvider;
  webhookSecret?: string;
  clock?: Clock;
}

interface DemoRequest extends Request {
  demoUser?: string;
}

function authenticate(req: DemoRequest, res: Response, next: NextFunction): void {
  const user = req.header("x-demo-user");
  if (!user) {
    res.status(401).json({ error: "x-demo-user is required" });
    return;
  }
  req.demoUser = user;
  next();
}

function asPublicTransfer(row: Record<string, unknown>) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    debitAccountId: row.debit_account_id,
    destinationAccount: row.destination_account,
    amount: row.amount_minor,
    status: row.status,
    providerReference: row.provider_reference,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function asPublicAccount(row: Record<string, unknown>) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    balance: row.balance_minor,
  };
}

export function createApp({
  db,
  provider,
  webhookSecret = "local-webhook-secret",
  clock = systemClock,
}: AppOptions) {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => ((req as Request & { rawBody?: Buffer }).rawBody = buf),
    }),
  );

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.get("/api/accounts", authenticate, (req: DemoRequest, res) => {
    const rows = db
      .prepare("SELECT id, owner_id, name, balance_minor FROM accounts WHERE owner_id = ?")
      .all(req.demoUser!) as Record<string, unknown>[];
    res.json(rows.map(asPublicAccount));
  });

  app.get("/api/transfers", authenticate, (req: DemoRequest, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const rows = status
      ? db
          .prepare(
            "SELECT * FROM transfers WHERE owner_id = ? AND status = ? ORDER BY created_at DESC",
          )
          .all(req.demoUser!, status)
      : db
          .prepare("SELECT * FROM transfers WHERE owner_id = ? ORDER BY created_at DESC")
          .all(req.demoUser!);
    res.json(rows.map((row) => asPublicTransfer(row as Record<string, unknown>)));
  });

  app.post("/api/transfers", authenticate, async (req: DemoRequest, res) => {
    const parsed = transferInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid transfer", details: parsed.error.issues });
      return;
    }

    const input = parsed.data;
    const idempotencyKey = req.header("idempotency-key");
    if (!idempotencyKey) {
      res.status(400).json({ error: "Idempotency-Key is required" });
      return;
    }

    const userid = req.demoUser;
    const requestHash = hash({
      debitAccountId: input.debitAccountId,
      destinationAccount: input.destinationAccount,
      amount: input.amount,
    });

    const paymentid = crypto.randomUUID();
    const outboxid = crypto.randomUUID();
    const now = clock.now().toISOString();

    try {
      db.exec("BEGIN IMMEDIATE");

      const account = db
        .prepare("SELECT * FROM accounts WHERE id = ?")
        .get(input.debitAccountId) as Record<string, unknown> | undefined;

      if (!account) {
        db.exec("ROLLBACK");
        res.status(404).json({ error: "account not found" });
        return;
      }

      if (account.owner_id !== userid) {
        db.exec("ROLLBACK");
        res.status(403).json({ error: "resource forbidden" });
        return;
      }

      if (Number(account.balance_minor) < input.amount) {
        db.exec("ROLLBACK");
        res.status(422).json({ error: "insufficient funds" });
        return;
      }

      const payment = db
        .prepare(
          `
        INSERT INTO transfers
          (id, owner_id, debit_account_id, destination_account, amount_minor, status,
           idempotency_key, fingerprint, provider_reference, failure_reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
      `,
        )
        .get(
          paymentid,
          req.demoUser!,
          input.debitAccountId,
          input.destinationAccount,
          input.amount,
          "pending",
          idempotencyKey,
          requestHash,
          null,
          null,
          now,
          now,
        ) as Record<string, unknown> | undefined;

      if (!payment) {
        throw new Error("transfer insert did not return a row");
      }

      db.prepare("UPDATE accounts SET balance_minor = balance_minor - ? WHERE id = ?").run(
        input.amount,
        input.debitAccountId,
      );

     // (I am writing to an outbox table for consistency and to give more control over state management)
      db.prepare(
        `
        INSERT INTO outbox (id, transfer_id, payload, topic) VALUES (?, ?, ?, ?)
        `,
      ).run(outboxid, paymentid, JSON.stringify(payment), TOPIC);

      db.exec("COMMIT");

      res.status(201).json(asPublicTransfer(payment));
    } catch (error) {
      db.exec("ROLLBACK");

      //check for the error returned on violation of the idempotency_key check and read the table for the existing transfer
      // Deliberately unsafe: accepted-but-timeout is reported as an ordinary failure and not persisted.
      res.status(502).json({ error: error instanceof Error ? error.message : "provider error" });
    }
  });

  app.post("/api/provider/webhook", (req, res) => {
    // TODO: the candidate must authenticate and deduplicate callbacks.
    const body = req.body as { eventId?: string; transferId?: string; status?: string };
    if (!body.transferId || !body.status) {
      res.status(400).json({ error: "invalid event" });
      return;
    }
    db.prepare("UPDATE transfers SET status = ?, updated_at = ? WHERE id = ?").run(
      body.status,
      clock.now().toISOString(),
      body.transferId,
    );
    res.json({ received: true, configuredSecretLength: webhookSecret.length });
  });

  app.post("/api/admin/reconcile", authenticate, async (req: DemoRequest, res) => {
    // TODO: restrict to ops-admin and make concurrent workers safe.
    const rows = db
      .prepare("SELECT * FROM transfers WHERE status IN ('pending', 'uncertain')")
      .all() as Record<string, unknown>[];
    let processed = 0;
    for (const row of rows) {
      if (!row.provider_reference) continue;
      const result = await provider.getStatus(String(row.provider_reference));
      if (result.status === "failed") {
        db.prepare("UPDATE accounts SET balance_minor = balance_minor + ? WHERE id = ?").run(
          Number(row.amount_minor),
          String(row.debit_account_id),
        );
      }
      db.prepare("UPDATE transfers SET status = ?, updated_at = ? WHERE id = ?").run(
        result.status,
        clock.now().toISOString(),
        String(row.id),
      );
      processed += 1;
    }
    res.json({ processed });
  });

  return app;
}
