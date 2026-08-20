import { createApp } from "./app.js";
import { createDatabase, seedDatabase } from "./db.js";
import { processOutbox } from "./outbox.js";
import { FakeProvider } from "./provider.js";

const db = createDatabase(process.env.DATABASE_FILE ?? "relaypay.sqlite");
seedDatabase(db);
const provider = new FakeProvider();

const app = createApp({
  db,
  provider,
  webhookSecret: process.env.WEBHOOK_SECRET ?? "local-webhook-secret",
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`RelayPay API listening on http://localhost:${port}`);
});

let workerRunning = false;

setInterval(() => {
  if (workerRunning) return;

  workerRunning = true;
  processOutbox({ db, provider })
    .catch((error) => {
      console.error("Outbox worker failed", error);
    })
    .finally(() => {
      workerRunning = false;
    });
}, 1000);
