---
"permdock": minor
---

`resource(…, { levels })` declares named conditions such as `own`, `team` and `all`, and a custom-role grant picks one with `{ permission, level }`. The level is ANDed into the ceiling grant in `resolveCustomRole`, snapshots, `customRoleClaim` (`key@level`) and `rls generate` in both modes; an undeclared level is dropped as `unknown-level` and denies. `assignableLevels(permission)` lists the levels a subject may hand out, the catalog lists `levels` per permission, `permdock diff` reports `level-removed` as breaking, and a snapshot binds every principal attribute it does not carry, such as `teamIds`, so `fromSnapshot` agrees with `decide`.
