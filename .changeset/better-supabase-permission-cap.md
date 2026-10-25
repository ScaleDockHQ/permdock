---
"permdock": patch
---

`authorizationHooks` from `permdock/better-supabase` now caps an automation run on better-supabase 0.15: `automation.runAs` writes the automation's keys to `bsb_permission_cap`, the claim 0.15 reads, as well as `bs_permission_cap` for 0.13 and 0.14. Before, a run on 0.15 kept every permission of its publisher.
