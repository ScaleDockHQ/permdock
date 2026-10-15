---
"permdock": patch
---

The Resend and PermDock Cloud webhook receivers answer `400` for missing or malformed signature headers and `403` for a signature that does not verify. They answered `401` without the `WWW-Authenticate` header RFC 9110 section 15.5.2 requires; a webhook has no authentication scheme to name there.
