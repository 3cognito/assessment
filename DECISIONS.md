# How I approached this

1. First assessed the risks 
   - assessed the risks and I documented them in a draft format in risk_notes.md (later expanded)
   - I probably should have spent more time on the call auditing

2. Scoped out the needed work
   - the commits will show the steps and order used. 

3. Implemented fixes in a defined manner and tested as I went
   - I also documented decisions below: 



# Payload validation

I modified the db schema to use `balance_minor` and `amount_minor`, added a positive integer check in the zod schema

- to ensure amounts are positive and whole, consistent with how minor units are represented

# Idempotency key handling

I let the db enforce transfer idempotency with a unique index on `(owner_id, idempotency_key)` and get the transfer if that happens

- prevents race during read and write (2 requests could see inexistent state and have access to insert)
- removes one db call on the likely path as more requests will probably use a unique idempotency key

If the stored request hash matches the new request hash, I return the original transfer, otherwise I return `409` (like the readme specified).

# Transaction handling

I verify that the authenticated user owns the debit account before committing the transfer.
I create the transfer, acct debit and outbox table inside one trx, commit on success and rollback on failures
I use an `outbox` table so provider calls can be made durable and also handled in the background in a non blocking manner

- It also gives more control over how transaction state is managed
- ensures two requests do not read the same balance where there should not, leading to a race

I read the account info in a trx started with `BEGIN IMMEDIATE` so access is locked
I use the publicfacing mapper to return only needed account fields so senstive info is not returned like bvn

# Admin actions

I restrict reconcile to `ops-admin` (per the readme) because it should only be accessible by admins.

# Webhooks

I verify provider webhooks with `x-provider-signature`, using a sha256 of the raw JSON body and webhook secret.
If the same event id is received again (checked by event id), I return success without applying the transfer update again.
I only apply provider webhook updates when the current transfer state allows the transition.

- I use a simple map and helper to model and validate allowed transitions
- only transient (pending or uncertain) states can move to terminal (succeed or failed) and not vice versa

I added other fields to the webhook table for audit and correctness

- why it was ignored, when it was applied, the status it carried (would store full payload in a full fledged case)

# Worker

The worker claims an outbox row before calling the provider

- uses the transfer id as the provider client reference, and then records the provider result.
- ok provider response remain in `pending`, rejected response become `failed`, and provider errors/timeouts become `uncertain`.

## note - limitation

The worker claims one row using `claimed_at` before calling the provider.

- This prevents another worker from claiming the same unprocessed row at the same time.
- if the process does not set processed at the outbox row will not be reclaimed and will remain unprocessed unless manually fixed
- a timeout and retry would address this with the transfer id still providing idempotency on the provider end

# Reversals

I added a `reversals` table with a unique constraint on `transfer_id` to ensure transactions can be reversed only once
Any place or path that needs to return money creates a reversal, then credits the account and marks the transfer `reversed`

- this prevents double reversals from any possible reversal path
- all done within a transaction
- I also added this to protect reconciliation two concurrent requests cannot create two reversals for the same transfer

# Reconciliation

I only allow reconciliation for uncertain transfers.
If the provider still reports `pending`, I leave the transfer as `uncertain`.
If the provider reports `succeeded`, I mark the transfer `succeeded`.
If the provider reports `failed`, I use the reversal path so the debit is returned exactly once.

# AI USE

I used AI to understand the db driver syntax and to convert rough db models to correct syntax and write tests (which i reviewed)
The client side update was also done by AI

# Client limitations

The transfer states on the client will remain pending since webhooks are not processed unless a local trigger is done
