---
"permdock": patch
---

`permdock openapi emit` writes `security` into an OpenAPI document, or an Overlay with `--kind overlay`. `permdock openapi emit --doc openapi.json --kind overlay --out openapi.overlay.json --check` exits 1 when the Overlay on disk would change.
