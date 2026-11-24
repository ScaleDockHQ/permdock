---
"permdock": minor
---

`rls verify --shadow`, `rls explain` and doctor `PD090`, `PD103`, `PD104` and `PD108` treat the policies an `@bsb access` tag renders as generated, reading them from better-supabase's `accessPolicies` instead of the `bsb_access_` name prefix; `rls explain --json` lists them under `tagged`.
