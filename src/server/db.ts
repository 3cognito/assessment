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
      balance INTEGER NOT NULL CHECK (balance >= 0),
      provider_token TEXT NOT NULL,
      bvn TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      debit_account_id TEXT NOT NULL REFERENCES accounts(id),
      destination_account TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT,
      provider_reference TEXT,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL
    );
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
