---
"permdock": patch
---

Instances with many custom roles build and decide faster: custom roles and grants are indexed per instance, `mayUse` reads one snapshot per instance, `decideIds` builds one instance per tenant, and `definePermDock().forClient(client)` returns the same bound definition for the same client. `where()` returns one `in` for equal-field alternatives and subtracts each deny once. The client batch posts at most 256 evaluations and 1 MiB per request and keeps at most 5,000 answers.
