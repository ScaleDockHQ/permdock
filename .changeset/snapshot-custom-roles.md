---
"permdock": minor
---

Breaking: `snapshotFor` leaves custom-role grants out of the snapshot and names the roles in `custom.held`; `customRoleRecord(policy, customRoles, tenant)` writes the tenant-level record and `fromSnapshot(snapshot, { customRoles })` merges it. A snapshot read without the record grants nothing from custom roles. A member with 10 custom roles drops from 9,095 to 4,975 bytes.
