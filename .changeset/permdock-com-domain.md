---
"permdock": minor
---

Every URL PermDock emits moves from `permdock.dev` to `permdock.com`: Problem Details `type` values (`https://permdock.com/problems/<slug>`), the `$id` and `$schema` of `catalog-v1.json`, `supabase-claims-v1.json` and `supabase-manifest-v1.json`, and the docs links in errors and CLI output. A client that matches on a `type` URI or a schema `$id` updates the host.
