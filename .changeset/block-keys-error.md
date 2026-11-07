---
"permdock": minor
---

Breaking: PD079 is an error. It also fails when `better-supabase/sql` does not export `modulePermissionKeys`, because the keys the blocks check cannot be listed. `permdock/better-supabase` exports `defineBlocksConfig<typeof policy>()`, which rejects a `blocks.<name>.permissions` value that is not a permission key of the policy at compile time.
