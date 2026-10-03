---
"permdock": minor
---

`isPermission(value)` is exported from `permdock`: it narrows an `unknown` such as an MCP tool's `meta` to `Permission` without a cast, and accepts a leaf that crossed JSON. `permdock/cli` exports `parseHookMarker(sql)` and `parseGrantsMarker(sql)`, which read the first line of a generated hook or `--grants-out` migration.
