---
"permdock": minor
---

`PermDockDeniedError` and `PermDockApprovalRequiredError` carry a stable `digest` (`PERMDOCK_DENIED;<permission>` and `PERMDOCK_APPROVAL_REQUIRED;<permission>;<token>`), the property React keeps when an error crosses from a Server Component to the client, and `parsePermDockDigest` reads it. The new `permdock/next/client` entry exports `PermissionBoundary`, an error boundary built on `catchError` from `next/error` that renders its `denied` or `approval` fallback for a thrown PermDock error and lets every other error through, and `usePermissionBoundary()`, which gives a fallback the permission, the approval token and `retry()`.
