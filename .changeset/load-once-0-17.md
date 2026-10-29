---
"permdock": minor
---

Breaking: permissions load once per authorization version. `getPermDock({ instances: instanceCache() })` and `permdockFor` reuse an instance until the version moves, and `VersionCache.seed` and `version: { known }` skip the version read. Run `permdock codemod 0.17` for the membership and approval literals; approval tokens issued before the upgrade no longer resume, because the token's policy input is now `source`.

| Old                                                                       | New                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `{ tenant, roles }`, `{ tenant, team, roles }` memberships                | `{ scope: 'tenant', id, roles }`, `{ scope: 'team', id, within: { tenant }, roles }` |
| `approval: { mode: 'any' \| 'all' \| 'sequential' }`                      | `approval: { combine }`                                                              |
| `approval: { distinct: false }`                                           | `approval: { mode: 'confirm' }`; `'authorize'` is the default                        |
| `ApprovalMode` (the stage combinator)                                     | `ApprovalCombine`; `ApprovalMode` is `'confirm' \| 'authorize'`                      |
| `VersionCache.observe`                                                    | `VersionCache.seed(id, version, at?)`                                                |
| `cacheLifeFor(snapshot)` capped at the token's expiry                     | `{ stale: 300 }`; `cacheLifeFor(snapshot, { capToToken: true })`                     |
| `postgrestSources` version read falling back to `subject_for`             | Throws; doctor PD083 reports a hook file without `authz_version_for`                 |
| CLI flags and commands renamed in 0.5.0 (`flag_renamed`, `command_moved`) | `unknown_flag`, `unknown_command`; `permdock codemod 0.5` still rewrites them        |
