---
"permdock": patch
---

A `deny` now applies to an update pair `{ current, next }` when either row matches it. `deny(permissions.invoice.update, { where: { locked: true } })` used to apply only when both rows were locked, so unlocking an invoice, or locking one, was granted in process and by `fromSnapshot` while the generated RLS refused it. A scoped deny likewise applies when the update moves the row into or out of its scope instance. Allows still need both rows to match, and `fromSnapshot` now also checks an update allow's `where` against the next row when the grant has no `check`, as `can` does.
