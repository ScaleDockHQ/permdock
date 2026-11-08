---
"permdock": minor
---

`snapshot({ omitStatic: true })` and `snapshotFor(..., { omitStatic: true })` replace the grants of declared roles with `static` references, a new optional field of the v1 snapshot: `{ held: [role, membershipIndex | null][], digests: Record<role, "sha-256:…"> }`. `permdock generate` with `gen.kinds: ["bundle"]` writes `bundle.ts`, a `"use client"` module exporting `clientBundle`, and the providers of `permdock/react`, `vue`, `svelte` and `solid`, `createClientStore` and the `permdock/next` provider take it as `bundle`. A client without a bundle, or with a stale digest, denies what the roles granted. `meta.clientBundle: false` keeps a role inline. `permdock snapshot size --omit-static` reports the effect. On the CentraKit-shaped fixture the snapshot falls from 34,937 B to 5,661 B.

Behaviour change: a snapshot now ships only the active tenant's grants by default, as the docs already said. A subject with several memberships and an active tenant used to receive every membership's grants; pass `tenants: "all"` for the old output. `grantedPermissions` still reads every tenant. A request with no active tenant is unchanged.

PermDock-Cloud reads the snapshot: it must ignore `static` or resolve it against the bundle of the policy it holds.
