---
"permdock": minor
---

`rls.staticGrants: 'ref'` leaves the `role_permissions` rows out of the generated SQL and pins the `sha-256:` hash of a `policy-bundle` v1 document. `permdock policy bundle` writes the bundle (`--kind sql` writes the statement that loads it into `<schema>.permdock_policy_bundle`). A missing or mismatched bundle denies every static grant. `permdock generate --only rls` rewrites the `helpers` part when you switch to `'ref'` and the pinned hash after each grant change, and the bundle load is a data migration you apply with it. The default `'inline'` keeps today's SQL byte for byte.
