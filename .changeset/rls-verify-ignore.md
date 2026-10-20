---
"permdock": minor
---

`permdock rls verify` gives every finding a stable id, `<code>:<table>:<key>`, printed at the end of its line, in GitHub annotations and as the SARIF `permdockId/v1` fingerprint. `rls.verify.ignore: [{ id, reason }]` and `--ignore <id>` accept a finding without failing the run, an entry that matches no finding warns, and `--json` data is `{ findings, ignored, stale }`.
