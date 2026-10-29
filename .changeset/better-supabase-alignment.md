---
"permdock": minor
---

`permdockFor` from `permdock/better-supabase` is generic over the policy vocabulary, so its instances keep their typed permissions. The CLI finds `better-supabase.config.*` from the directory of `permdock.config.ts` up to the workspace root, so a monorepo app picks up the root config and its broadcast topic defaults to `better_supabase:authz`.
