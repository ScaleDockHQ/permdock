---
"permdock": patch
---

`permdock rls generate --no-seeds` skips the `seeds` part under `--split`, and any command that writes a file writes a character device such as `/dev/null` in place instead of failing with `EPERM`.
