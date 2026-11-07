---
"permdock": minor
---

Breaking: `authorizationProvider` fills `platformRoles` from `rls.roles` and `functions.subject` from `permdock_subject()` unless `platformRoles` or `subject` is `false`. `suspension.userKey` is `rls.suspension.users.id`. `personas: "roles"` builds one persona per catalog role. A role source `where` lists that scope's roles and treats a non-null `customRoleTenant` as a custom role. `approverFor` and `managedUsers` call `permdock_approver_for_ids` and `permdock_managed_user_ids` when the manifest lists them. Pass `permissions` to type the provider's keys.
