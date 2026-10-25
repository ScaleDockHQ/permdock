---
"permdock": patch
---

`authorizationHooks` from `permdock/better-supabase` now caps an automation run on better-supabase 0.15 and later: `automation.runAs` writes the automation's keys to `bsb_permission_cap`, the claim 0.15 and 0.16 read, as well as `bs_permission_cap` for 0.13 and 0.14. Before, a run on 0.15 or 0.16 kept every permission of its publisher, or relied on 0.16's deprecated `bs_permission_cap` fallback.
