---
"permdock": patch
---

`permdock diff a b` compares two policies or catalogs (a `permissions.catalog.json` or a module exporting `policy`) and lists the permissions, scopes, roles and grants that changed. It exits `1` on a breaking change: a removed permission, scope, role or allow, a narrowed allow (new or changed `where` / `check`, new approval, fewer fields, shorter validity, new limit), or a new or changed deny. `--impact` runs the `rls verify` fixtures through both policies and reports who loses or gains what; a lost grant is breaking. `--json` prints the report. The catalog gains a `grants` section listing every code grant in canonical order when built with the policy; `CatalogGrant` and `CatalogValidity` are exported from `permdock/catalog`.
