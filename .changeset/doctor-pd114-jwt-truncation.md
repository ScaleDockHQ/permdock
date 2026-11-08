---
"permdock": minor
---

`permdock doctor` reports PD114 for `rls.authorize: "jwt"` with a token hook: the helpers read only the memberships the hook budget keeps. With `--db-url-stdin` it is an error for a sample user whose token is truncated. No generated SQL changes; use `rls.authorize: "database"`, which reads the tables for a truncated token.
