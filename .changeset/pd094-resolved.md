---
"permdock": minor
---

Doctor `PD094` compares resolved values as better-supabase's BS427 does (sorted keys, collapsed whitespace, case of unquoted SQL names), also reports `blocks.impersonation.options.claimsHook` and block permission keys the provider supplies, and warns when `blocks.permissions.disabled` is a column string where the provider supplies the row form, because a user or tenant with no row then passes better-supabase's block functions.
