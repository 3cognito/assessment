MAIN ISSUES I FOUND

1. Only the owner of a debit account should be able to initiate a transfer from it.
    risk: if ownership is not checked this can allow a bad actor move money from an account that is not theirs
    fix:
    - fix by checking account ownership: matching account `owner_id` column to `user_id` from authenticated request
2. A transfer request should only cause at most one local debit.
    risk: if not handled properly, duplicate requests can process the same intent and lead to duplicate debits
    fixes:
    - handled by ensuring db uniqueness on `idempotency_key` and `user_id` pair
    - making changes in a transaction and checking request hash to return 409 or 200 (with already processed transfer)
3. A transfer request should only cause at most one provider instruction to be executed
    - same risk and fix as above
4. Race conditions when intitiating transfers and when reconciling should be prevented
    risk: incorrect balance states can occur when two processes or request read the same state and attempt separate updates
    fix:
    - acquire locks (begin immediate) when reading data that needs to be accessed in isolation
5. Webhook can only come from verified sources and should be handled idempotently
    risk: improper validation of webhooks can lead to record manipulations by bad actors, out of order hooks can create wrong side effects
    fixes:
    - validate webhook credentials using the specified secure approach (in realworld, may vary by provider)
    - proper state transitions and webhook records/syncing 
    - storing event id for deduping and ignoring out of order or already processed states
6. Transfer initiation should be self contained but leave durable records for background processing
    risks:
    increased latency on the intiation path if provider calls happen there
    limitted ability to manage provider and transaction state, possible record drifts
    fixes:
    use outbox table to create a durable intent and move provider call out of initiation path
    process stored intent in background with worker to eventually sync provider calls
7. Amounts are already in the minor units (from the README.md) so no need to convert anymore (I will change syntax to reflect that)

8. A provider timeout is not a failure. It is an unknown state that must be reconciled.
    risk: treating timeouts as failures risks losing the true provider state and if reversal is auto, incorrect reversals and loss
    fixes:
    - handled by representing uncertain outcomes clearly and definitively with its own status
    - reconcile later by getting provider final outcome via and syncing where the state transition is logical
9. It should not be possible to move a succeeded, failed, or reversed transfer back to pending or uncertain.
    risk: inconsistent state and handling, reversals after success, and broken records
    fixes:
    - implement defined state transitions and only allow valid transitions
9. 
10. If reversal needs to happen, it should happen only once per transfer.
    risk: improperly implemented reversals would allow possible multiple reversals per transfer
    fix:
    - ensure reversals are properly scoped, happen within a transaction and atomically happen or fail
    - I used a dedicated reversal table with unique index on the transaction id
11. Only verified admins should be able to carry out admin actions.
    risk: bad actor can carry out admin actions
    fix:
    - check credentials for correct admin permisions
12. The responses from the API should not expose sensitive data.
    risk: exposure of user or system data to unauthorized persons
    fix:
    - use a public mapper function to scope public responses