---
"permdock": patch
---

Check PowerSync followed-row fixtures shaped as `{ subject, table, row, expected }` against parent access and the generated table stream. Reject invalid fixtures and report leaked or missing attachment rows instead of silently leaving followed tables unchecked.
