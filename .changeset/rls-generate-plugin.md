---
"permdock": minor
---

Breaking: `permdock rls generate` is removed. Set `out`, `split`, `target`, `schemas` and `seeds` on `rls()` and run `permdock generate --only rls`. The old command fails with one suggestion. `seeds: false` replaces `--no-seeds`, and `seeds: { out, backfill }` replaces `--seeds-out` and `--backfill-out`. `rls.seeds` still accepts `'function'` and `'view'`.
