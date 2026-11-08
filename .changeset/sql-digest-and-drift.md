---
"permdock": minor
---

The generated helpers start with `-- permdock helpers (…) sha-256:<digest>`, the digest of the helper text after that line, and doctor PD115 warns when the newest migration that holds the helpers carries a different digest from the schema file. `permdock generate` prints `seeds: +N rows, -M rows` against the newest seeds migration when a new one is due. `permdock generate --only rls` rewrites the helpers file once, for the header line only; the function bodies are unchanged and no data migration is needed.
