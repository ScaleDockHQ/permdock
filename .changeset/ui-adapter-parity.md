---
"permdock": minor
---

`permdock/vue`, `permdock/svelte` and `permdock/solid` export `PermissionBoundary`, which renders `denied` or `approval` for a thrown `PermDockDeniedError` or `PermDockApprovalRequiredError` (Svelte 5.3 or later). Their providers accept `endpoint: false`, read a `headers` getter on every request, and call `refresh({ tenant })` when a `tenant` ref, getter or prop changes. `useAssignablePermissions` and `assignablePermissions` take a getter, Vue exports `ProtectedProps`, and `permdock/svelte` exports `requiredPlans` under the `svelte` condition.

Breaking: Vue composables and Solid hooks throw when called outside `setup()`, an `effectScope` or a reactive owner, because their store subscription could never be removed there.
