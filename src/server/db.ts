import { DatabaseSync } from "node:sqlite";

export type AppDatabase = DatabaseSync;

/*I canNot write a comment in the db.exec statement but I would like to note that I would
rather have the unique index on idemp_key, debit_acct_id (that is what comes to my mind first) but readme says user + key
I think either way is fine
*/
export function createDatabase(filename = ":memory:"): AppDatabase {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      balance_minor INTEGER NOT NULL CHECK (balance_minor >= 0),
      provider_token TEXT NOT NULL,
      bvn TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      debit_account_id TEXT NOT NULL REFERENCES accounts(id),
      destination_account TEXT NOT NULL,
      amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
      status TEXT NOT NULL DEFAULT 'pending',
      idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      provider_reference TEXT,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_owner_idempotency_key
      ON transfers (owner_id, idempotency_key);

    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      transfer_id TEXT NOT NULL,
      status TEXT NOT NULL,
      received_at TEXT NOT NULL,
      applied_at TEXT,
      ignored_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      transfer_id TEXT NOT NULL UNIQUE REFERENCES transfers(id),
      claimed_at TEXT,
      processed_at TEXT,
      last_error TEXT
    );
  `);
  return db;
}

export function seedDatabase(db: AppDatabase): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO accounts
      (id, owner_id, name, balance_minor, provider_token, bvn)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insert.run("acc-a", "user-a", "Tobi Demo", 500_000, "demo-token-a", "00000000001");
  insert.run("acc-b", "user-b", "Ada Demo", 250_000, "demo-token-b", "00000000002");
}
