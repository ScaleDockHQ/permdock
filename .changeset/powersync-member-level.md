---
"permdock": minor
---

`powersync.memberLevel.<resource>` (`{ table, column }`, type `PowerSyncMemberLevel`) narrows a generated PowerSync stream by the member's level: a membership column holding `own`, `team`, `all` or null syncs the rows of the resource's `own` or `team` level, or the whole tenant, instead of every row of the tenant on each device.
