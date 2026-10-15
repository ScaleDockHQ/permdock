---
"permdock": minor
---

`permdock casl import` and `permdock casbin import` turn rules kept in another library into a generated module with `permissions` and a `policy` of roles.

- `casl import --rules <file> --out <file>` reads each role's `ability.rules` or `packRules` output. Inverted rules become denies, `manage` and `all` expand, `fields` carry over, and the Mongo-query condition subset becomes `where`.
- `casbin import --model <file> --policy <file> --out <file>` reads an RBAC model, with or without domains, under the standard matcher. Role inheritance is flattened, deny rows become denies, and user-to-role lines become an `assignments` export.

Both report every rule they cannot translate. A deny is never dropped silently: a CASL deny keeps its effect without the condition, and `casbin import` exits 1 when a deny line did not import. `scan --legacy` points at `casl import` when it finds CASL abilities.
