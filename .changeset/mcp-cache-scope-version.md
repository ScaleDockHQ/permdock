---
"permdock": patch
---

`permdock/mcp` adds `cacheScope: 'private'` to a filtered `tools/list`, `prompts/list`, `resources/list` or `resources/templates/list` result only when the request was sent under protocol revision 2026-07-28 or later. A 2025-era result no longer carries the field, which that revision does not define.
