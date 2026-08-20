import type { AppDatabase } from "./db.js";
import { reverseTransfer } from "./reversal.js";
import { systemClock, type Clock, type TransferProvider } from "./types.js";

interface ClaimedOutboxRow {
  id: string;
  transfer_id: string;
  destination_account: string;
  amount_minor: number;
}

function claimNextRecord(db: AppDatabase, now: string): ClaimedOutboxRow | undefined {
  db.exec("BEGIN IMMEDIATE");

  try {
    const row = db
      .prepare(
        `
        SELECT
          outbox.id,
          outbox.transfer_id,
          transfers.destination_account,
          transfers.amount_minor
        FROM outbox
        JOIN transfers ON transfers.id = outbox.transfer_id
        WHERE outbox.processed_at IS NULL
          AND outbox.claimed_at IS NULL
        ORDER BY outbox.id
        LIMIT 1
      `,
      )
      .get() as ClaimedOutboxRow | undefined;

    if (!row) {
      db.exec("COMMIT");
      return undefined;
    }

    db.prepare(
      `
      UPDATE outbox
      SET claimed_at = ?
      WHERE id = ?
        AND claimed_at IS NULL
        AND processed_at IS NULL
    `,
    ).run(now, row.id);

    db.exec("COMMIT");
    return row;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function process(
  db: AppDatabase,
  provider: TransferProvider,
  clock: Clock = systemClock,
): Promise<number> {
  const record = claimNextRecord(db, clock.now().toISOString());

  if (!record) {
    return 0;
  }

  try {
    const providerResult = await provider.send({
      clientReference: record.transfer_id,
      destinationAccount: record.destination_account,
      amount: record.amount_minor,
    });

    const now = clock.now().toISOString();

    db.exec("BEGIN IMMEDIATE");
    try {
      const transfer = db.prepare("SELECT * FROM transfers WHERE id = ?").get(record.transfer_id) as
        | Record<string, unknown>
        | undefined;

      if (!transfer) {
        throw new Error("transfer not found for outbox record");
      }

      if (providerResult.status === "rejected") {
        db.prepare(
          `
          UPDATE transfers
          SET provider_reference = ?, updated_at = ?
          WHERE id = ?
        `,
        ).run(providerResult.providerReference, now, record.transfer_id);

        reverseTransfer(
          db,
          { ...transfer, provider_reference: providerResult.providerReference },
          now,
          "provider rejected",
        );
      } else {
        db.prepare(
          `
          UPDATE transfers
          SET status = ?, provider_reference = ?, failure_reason = ?, updated_at = ?
          WHERE id = ?
        `,
        ).run("pending", providerResult.providerReference, null, now, record.transfer_id);
      }

      db.prepare(
        `
        UPDATE outbox
        SET processed_at = ?, last_error = NULL
        WHERE id = ?
      `,
      ).run(now, record.id);

      db.exec("COMMIT");
      return 1;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    const now = clock.now().toISOString();
    const failureReason = error instanceof Error ? error.message : "provider error";

    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `
        UPDATE transfers
        SET status = 'uncertain', failure_reason = ?, updated_at = ?
        WHERE id = ?
          AND status IN ('pending', 'uncertain')
      `,
      ).run(failureReason, now, record.transfer_id);

      db.prepare(
        `
        UPDATE outbox
        SET processed_at = ?, last_error = ?
        WHERE id = ?
      `,
      ).run(now, failureReason, record.id);

      db.exec("COMMIT");
      return 1;
    } catch (rollbackError) {
      db.exec("ROLLBACK");
      throw rollbackError;
    }
  }
}

export async function processOutbox({
  db,
  provider,
  clock,
}: {
  db: AppDatabase;
  provider: TransferProvider;
  clock?: Clock;
}): Promise<number> {
  let total = 0;

  while (true) {
    const processed = await process(db, provider, clock);
    if (processed === 0) {
      return total;
    }

    total += processed;
  }
}
