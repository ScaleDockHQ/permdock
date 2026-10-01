---
'permdock': patch
---

Overlay actions now target operations with `$.paths.*[?@.operationId == '<id>']`. The old target had an extra `.*` and selected nothing. `permdock openapi emit --format overlay` covers the source document's operations by their own `operationId`, fails on a covered operation without one, and under `--check` reports operations whose source already sets `security`. `overlay({ operations })` takes the same list. Actions are sorted, and `info.version` is a catalog fingerprint. `x-permdock-conditions` and `x-permdock-approval` are objects keyed by permission key, as the extension table defines.
