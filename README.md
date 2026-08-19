# RelayPay: backend-heavy full-stack assessment

RelayPay is a deliberately unsafe miniature bank-transfer service. Your job is not to add lots of features. Your job is to make a small money-moving system correct, secure, observable, and operable when requests race and an external provider behaves imperfectly.

The starter contains an Express/TypeScript API, a local SQLite database, a deterministic fake payment provider, a small React operations screen, and passing smoke tests. It requires no cloud account, Docker, paid service, or real credential.

## Timebox

Target **5 hours**. Stop after 6 hours and document what you would do next. We value prioritisation and explicit trade-offs more than an over-large submission.

## Start

Requirements: Node.js 22 or newer and npm.

```bash
npm install
npm test
npm run dev
```

- UI: http://localhost:5173
- API: http://localhost:3001
- Demo identities: `user-a`, `user-b`, and `ops-admin`, passed in the `x-demo-user` header. Authentication is simulated; **authorization is in scope**.
- All money is in integer minor units. `125000` means ₦1,250.00.

## Scenario

`POST /api/transfers` asks an external provider to transfer money from a user's RelayPay account. In real life:

- clients retry requests;
- two application instances can receive the same request;
- a provider can accept a transfer and then time out before replying;
- callbacks can be duplicated, forged, or arrive out of order;
- workers can run concurrently;
- local persistence can fail after an external side effect.

The current implementation is intentionally vulnerable to these conditions.

## Your assignment

### 1. Audit first

Create `RISK_NOTES.md`. Identify and rank the most important failure modes in the starter. Explain the invariant each can break. Do not try to fix every style issue.

### 2. Make transfer initiation safe

Keep `POST /api/transfers`, but make it satisfy all of these contracts:

- Only the owner of the debit account may initiate a transfer.
- `amount` must be a positive integer minor-unit value; never infer or multiply units.
- Require an `Idempotency-Key` header.
- The same user + key + same request must cause at most one provider instruction and one debit, even under concurrent requests.
- Reusing the key with a different request must return `409` and cause no new side effect.
- A repeated completed request should return the original result.
- Never report a transfer as failed merely because the provider response was lost. Represent uncertainty explicitly.

You may change the schema and implementation. Preserve the `createApp(...)` export and public HTTP routes so automated checks can run.

### 3. Secure callbacks and reconciliation

Implement:

- `POST /api/provider/webhook`: verify `x-provider-signature` as a hex HMAC-SHA256 of the exact JSON body using `WEBHOOK_SECRET`; reject invalid signatures; deduplicate events; enforce valid transfer state transitions.
- `POST /api/admin/reconcile`: allow only `ops-admin`; query uncertain transfers through `provider.getStatus`; settle or reverse exactly once, even if two workers run together.

Document how your design handles “provider accepted, response lost, callback delayed.” Do not claim distributed exactly-once delivery; explain the invariants you can actually enforce.

### 4. Make the thin operations UI useful

Improve the existing screen enough that an operator can:

- distinguish `pending`, `uncertain`, `succeeded`, `failed`, and `reversed` transfers;
- see which records need reconciliation;
- filter the transfer list by status;
- understand loading and error states.

Backend correctness is weighted much more heavily than visual polish.

### 5. Prove it

Add focused tests covering concurrency, idempotency conflicts, authorization, amount units, invalid/duplicate callbacks, and repeated reconciliation. Include a short `DECISIONS.md` with:

- your invariants and transaction boundaries;
- how you would replace local SQLite and the in-process worker at scale;
- logging, metrics, alerting, and audit data you would add;
- known limitations and the next three changes you would make.

## Rules

- Use any free/open-source package, but keep `npm install && npm test && npm run dev` sufficient.
- Do not use a paid API or require cloud configuration.
- AI tools are allowed. You must list where they helped in `DECISIONS.md`; you remain responsible for every line.
- Do not add real credentials or production data.
- Prefer a small correct design over a broad rewrite.

## Submission

Send a Git repository or zip containing the source, tests, `RISK_NOTES.md`, and `DECISIONS.md`. Do not include `node_modules` or generated build output.
