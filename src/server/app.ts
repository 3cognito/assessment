import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { AppDatabase } from "./db.js";
import { systemClock, type Clock, type TransferProvider } from "./types.js";

const transferInput = z.object({
  debitAccountId: z.string().min(1),
  destinationAccount: z.string().regex(/^\d{10}$/),
  amount: z.number().positive(),
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
    debitAccountId: row.debit_account_id,
    destinationAccount: row.destination_account,
    amount: row.amount,
    status: row.status,
    providerReference: row.provider_reference,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createApp({
  db,
  provider,
  webhookSecret = "local-webhook-secret",
  clock = systemClock,
}: AppOptions) {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => ((req as Request & { rawBody?: Buffer }).rawBody = buf) }));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.get("/api/accounts", authenticate, (req: DemoRequest, res) => {
    // Deliberately unsafe: this exposes provider credentials and identity data.
    const rows = db.prepare("SELECT * FROM accounts WHERE owner_id = ?").all(req.demoUser!);
    res.json(rows);
  });

  app.get("/api/transfers", authenticate, (req: DemoRequest, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const rows = status
      ? db.prepare("SELECT * FROM transfers WHERE owner_id = ? AND status = ? ORDER BY created_at DESC").all(req.demoUser!, status)
      : db.prepare("SELECT * FROM transfers WHERE owner_id = ? ORDER BY created_at DESC").all(req.demoUser!);
    res.json(rows.map((row) => asPublicTransfer(row as Record<string, unknown>)));
  });

  app.post("/api/transfers", authenticate, async (req: DemoRequest, res) => {
    const parsed = transferInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid transfer", details: parsed.error.issues });
      return;
    }

    const input = parsed.data;
    const idempotencyKey = req.header("idempotency-key") ?? null;
    const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(input.debitAccountId) as
      | Record<string, unknown>
      | undefined;

    if (!account) {
      res.status(404).json({ error: "account not found" });
      return;
    }
    if (Number(account.balance) < input.amount) {
      res.status(422).json({ error: "insufficient funds" });
      return;
    }

    // Deliberately unsafe: check-then-act, optional key, provider called before reservation,
    // no ownership check, and unrelated DB writes are not atomic.
    if (idempotencyKey) {
      const existing = db.prepare("SELECT * FROM transfers WHERE owner_id = ? AND idempotency_key = ?").get(req.demoUser!, idempotencyKey);
      if (existing) {
        res.json(asPublicTransfer(existing as Record<string, unknown>));
        return;
      }
    }

    const id = crypto.randomUUID();
    const now = clock.now().toISOString();

    try {
      const providerResult = await provider.send({
        clientReference: id,
        destinationAccount: input.destinationAccount,
        amount: input.amount,
      });
      const status = providerResult.status === "accepted" ? "succeeded" : "failed";

      if (status === "succeeded") {
        db.prepare("UPDATE accounts SET balance = balance - ? WHERE id = ?").run(input.amount, input.debitAccountId);
      }
      db.prepare(`
        INSERT INTO transfers
          (id, owner_id, debit_account_id, destination_account, amount, status,
           idempotency_key, provider_reference, failure_reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        req.demoUser!,
        input.debitAccountId,
        input.destinationAccount,
        input.amount,
        status,
        idempotencyKey,
        providerResult.providerReference,
        status === "failed" ? "provider rejected" : null,
        now,
        now,
      );
      const row = db.prepare("SELECT * FROM transfers WHERE id = ?").get(id) as Record<string, unknown>;
      res.status(201).json(asPublicTransfer(row));
    } catch (error) {
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
    const rows = db.prepare("SELECT * FROM transfers WHERE status IN ('pending', 'uncertain')").all() as Record<string, unknown>[];
    let processed = 0;
    for (const row of rows) {
      if (!row.provider_reference) continue;
      const result = await provider.getStatus(String(row.provider_reference));
      if (result.status === "failed") {
        db.prepare("UPDATE accounts SET balance = balance + ? WHERE id = ?").run(
          Number(row.amount),
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
