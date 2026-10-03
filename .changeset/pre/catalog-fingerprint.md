---
"permdock": minor
---

Catalog v1 carries a top-level `fingerprint` and per-permission `approvals`. `catalogFingerprint(catalog)` is exported from `permdock`: base64url SHA-256 over canonical JSON without `generatedAt`, `generator`, `fingerprint` and `usages`, so the CLI version and call sites no longer change it. `permdock collect --check` ignores `generator`.
