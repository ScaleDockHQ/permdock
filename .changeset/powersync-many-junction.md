---
"permdock": minor
---

`permdock powersync generate` widens the junction of `blockMembershipSource({ roles: "many" })` to every member of the caller's organisations, whatever the table is called, and no longer widens a plain junction named `membership_roles`. The caller's and the listed member's membership both keep the source's `disabledAt` column. PD102 warns when `sync-config.yaml` still filters that junction with `<table>.user_id = auth.user_id()`.
