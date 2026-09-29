---
'permdock': minor
---

Subject attributes in RLS. `permdock rls generate` compiles nested claim refs (`principal.claims.attrs.region` becomes `(select auth.jwt()) -> 'attrs' ->> 'region'`, with every segment checked against the prototype-key blocklist), casts a claim to the column's type read from the resource's Standard JSON Schema (`numeric`, `boolean`, `timestamptz`, `date`, `uuid`; numbers and booleans must be that JSON kind), and compiles `in` / `notIn` against an array claim to `= any (array(select ...))`, evaluated once per statement. A grant that reads `context.*` is refused with a pointer to the new doctor check PD027 (`--only context-refs`), or skipped under `--skip-closures`. `rlsParity` accepts subject `claims` and a `neon` dialect.
