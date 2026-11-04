---
"permdock": minor
---

Detect better-supabase through `betterSupabase.config` in `permdock.config.ts` or through a `better-supabase` dependency in the nearest `package.json` or a workspace package, not only through a `better-supabase.config.*` found upward from the config. The generated hook then broadcasts on `better_supabase:authz`, so a project whose better-supabase config sits in another package no longer gets `permdock:authz`. Doctor PD087 warns about a pinned topic better-supabase does not listen on and about a dependency whose config is not found.
