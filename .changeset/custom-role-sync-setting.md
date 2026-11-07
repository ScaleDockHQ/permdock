---
"permdock": minor
---

Breaking: a signed-in custom-role write is checked even when another trigger wrote it. The check is skipped only when the transaction sets `permdock.sync`. `customRoleWrites.requires` is matched at global scope for a global role and at the role's tenant otherwise. Deleting a role calls `permdock_trusted_delete_custom_role_grants` and removes `include_role` references, never a declared role.
