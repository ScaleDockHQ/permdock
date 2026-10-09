---
"permdock": minor
---

New `permdock/better-supabase` entry for better-supabase 0.6, which is an optional peer.

- `authorizationProvider({ manifest, catalog, scope?, approver? })` builds its `authorization` config from `permdock.manifest.json` and `permissions.catalog.json`. With `rls.customRoles` at a root tenant scope, `canAssign` and `canAssignFor` call `permdock_can_assign_any` and its `_for` form, so better-supabase's `can_assign` accepts custom roles. `permissionsFor` calls the new `permitted_<scope>_permission_keys_for` helper that `rls.mode: 'database'` writes. `approver` sets `canApprove` with `approvals.distinctApprover`. Scopes carry a normalised `idType`, and a missing catalog is reported in `problems`.
- `bucketPolicy` and `topicPolicy` build its storage and realtime access policies from `Permission` references.
- `apiKeyVerifier({ keys, manifest?, serviceRoles?, allPermissions? })` turns its API keys block into a `CredentialVerifier`; `serviceRoles` defaults to the manifest's `rls.apiKeys.serviceRoles`. Keys need `createApiKeys({ prefix: "pdk" })`. `apiKeyClaimOptions` reads its `api_key` claim settings from `rls.apiKeys`.
- `subjectFromBetterSupabase(session, options?)` reads its sessions with the `features` claim as plans; `plans: { claim, keys }` decodes `entitlements.claim.keys` short codes, and `apiKeys` maps an `apiKey` session to the key's credential subject.
- `toolPolicy({ permdock, data? })` returns the `authorize` and `visible` hooks of `createMcp` for tools whose `meta` is a permission.
- `credentialGuard(provider, { permdock, use, revoke? })` wraps a `CredentialProvider` so PermDock decides each token use.

The Supabase manifest's helper names may now end in `_permission_keys` and `_permission_keys_for`. Regenerate `permdock.manifest.json` with `permdock supabase inspect --out`.
