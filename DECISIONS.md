

I modified the db schema to use `balance_minor` and `amount_minor`

# Idempotency key handling
I let the db enforce transfer idempotency with a unique index on `(owner_id, idempotency_key)` and read the value on that failure
 - prevents race during read and write (2 requests could read inexistent state and have access to insert)
 - removes one db call on the likely path as more requests will probably be fresh (unique idempotency key)

If the stored request hash matches the new request hash, I return the original transfer, otherwise I return `409` (like the readme specified).

# Transaction handling

I create the transfer, acct debit and outbox table inside one trx, commit on success and rollback on failure
I use an `outbox` table so provider calls can be made durable and also handled in the background in a non blocking manner
 - It also gives more control over how transaction state is managed
I read the account info in a trx started with `BEGIN IMMEDIATE` (would do something like `for update` in pg)
 - ensures two requests do not read the same balance where there should not, leading to a race
I use the publicfacing mapper to return only needed account fields so senstive info is not returned like bvn 


