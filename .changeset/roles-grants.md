---
"permdock": minor
---

Add `permdock roles grants [--role <name>]`, which lists the grants each role holds, one row per permission after `allow(permissions.invoice)` expands. Roles still do not inherit from one another. No files are written and no generated SQL changes.
