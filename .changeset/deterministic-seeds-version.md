---
"permdock": minor
---

`permdock rls generate --seeds-out <directory>` numbers a new seeds migration one second after the newest versioned migration in the directory instead of using the current time, so regenerating the same directory gives the same file name and `--check` names the same missing file on every run. The clock is read only when the directory holds no versioned migration. A seeds migration still sorts after the migrations that create `role_permissions`, and an unchanged policy still writes nothing.
