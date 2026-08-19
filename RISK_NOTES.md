 //I need to verify account ownership - this prevents a request coming in from someone who does not own the account
//what happens if I have multiple requests attempting to modify this user's balance? - acquire a lock when getting the account - this would prevent concurrent requests from seeing the same balance when they should not
//I would attempt to insert the transfer first and let the db fail on a unique constraint on the idempotency key (do i add this?) - this would ensure the idempotency check is actually useful, current model would allow duplicate writes where two requests race
//provider should not be called before any records are stored - a successful request on the provider side without corresponding db records will lead to significant inconsistencies
//inserts should be done in a transaction to preserve atomicity



//I would typically not store bvn on the account table