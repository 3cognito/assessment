MAIN ISSUES I FOUND

1. Only the owner of a debit account should be able to initiate a transfer from it.
2. A transfer request should only cause at most one local debit.
3. A transfer request should only cause at most one provider instruction to be executed
4. Amounts are already in the minor units (from the README.md) so no need to convert anymore (I will change syntax to reflect that)
5. A provider timeout after acceptance is not a failure. It is an uncertainty that must be reconciled.
6. It should not be possible to move a succeeded, failed, or reversed transfer back to pending or uncertain.
7. If reversal needs to happen, it should happen only once per transfer.
8. Only verified admins should be able to carry out admin actions.
9. The responses from the API should not expose sensitive data.