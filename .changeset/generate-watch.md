---
"permdock": minor
---

`permdock generate --watch` generates again when a policy, config or plugin input changes. Each cycle loads the policy in a new worker and prints one receipt. `--json` prints one JSON line per cycle. Ctrl-C exits 130.
