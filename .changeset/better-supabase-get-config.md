---
"permdock": patch
---

Doctor PD123 reads the better-supabase config through `getConfig` from `better-supabase/cli`, the name better-supabase 0.88.0 gives `loadConfig`, and falls back to `loadConfig` for 0.84.0 to 0.87.x. Before, a project on better-supabase 0.88.0 or later got "the installed better-supabase has no listActions" and no PD123 findings.
