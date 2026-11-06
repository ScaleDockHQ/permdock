---
"permdock": minor
---

The authorization version bumps once per statement. A direct membership table gets `permdock_authz_version_insert`, `_update` and `_delete` statement triggers with transition tables in place of the row trigger `permdock_authz_version`, and the version table broadcasts from two statement triggers. A bulk insert of 100 rows for one user bumps that user once and sends one broadcast. Source tables that read their user through another table keep their row triggers.
