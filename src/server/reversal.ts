import crypto from "node:crypto";
import type { AppDatabase } from "./db.js";

export function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

//this has to be called within an existing tx, hence it receiving the tx as a parameter
export function reverseTransfer(
  db: AppDatabase,
  transfer: Record<string, unknown>,
  now: string,
  reason: string,
) {
  try {
    db.prepare(
      `
      INSERT INTO reversals
        (id, transfer_id, account_id, amount_minor, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run(
      crypto.randomUUID(),
      String(transfer.id),
      String(transfer.debit_account_id),
      Number(transfer.amount_minor),
      reason,
      now,
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return false;
    }

    throw error;
  }

  db.prepare("UPDATE accounts SET balance_minor = balance_minor + ? WHERE id = ?").run(
    Number(transfer.amount_minor),
    String(transfer.debit_account_id),
  );

  db.prepare("UPDATE transfers SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?").run(
    "reversed",
    reason,
    now,
    String(transfer.id),
  );

  return true;
}
