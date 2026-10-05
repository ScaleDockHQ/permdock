---
"permdock": minor
---

`rls generate --seeds-out` takes a migrations directory (a path ending in `/`, or an existing directory). It compares the rows with the newest migration there that starts with `-- permdock:seeds v1` and writes a new `<version>_permdock_seeds.sql` only when they changed, so declarative-schema projects no longer rewrite an applied seeds migration in place. `--check` fails while that newest seeds migration is missing or out of date.
