import { DatabaseSync } from "node:sqlite";

export type AppDatabase = DatabaseSync;

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
      status TEXT NOT NULL DEFAULT pending,
      idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      provider_reference TEXT,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX idx_idempotency_key_debit_account ON transfers (idempotency_key, debit_account_id)

    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY,
    transfer_id TEXT NOT NULL REFERENCES transfers(id)
    payload TEXT NOT NULL,
    processed_at TEXT,
    topic TEXT NOT NULL,
    )
  `);
  return db;
}

export function seedDatabase(db: AppDatabase): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO accounts
      (id, owner_id, name, balance, provider_token, bvn)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insert.run("acc-a", "user-a", "Tobi Demo", 500_000, "demo-token-a", "00000000001");
  insert.run("acc-b", "user-b", "Ada Demo", 250_000, "demo-token-b", "00000000002");
}

export function begin() {}

export function commit() {}

export function rollback() {}
