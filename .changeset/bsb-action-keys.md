---
"permdock": minor
---

`permdock codemod bsb-action-keys` moves the keys a `better-supabase.config.ts` `blocks` entry names under `permissions` into the `answers` of the matching permission, so `authorizationProvider` sends them as `actionKeys`.
