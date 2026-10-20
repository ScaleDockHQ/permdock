---
"permdock": patch
---

`permdock collect --check` and `permdock catalog --check` no longer fail when only `usages[].line` changed. They exit 0 with the notice `catalog usages moved (lines only)`, and `--json` reports `positionsMoved: true`.
