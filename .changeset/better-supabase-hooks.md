---
"permdock": minor
---

Breaking: `authorizationProvider` from `permdock/better-supabase` never sets `canApprove`; `approver` becomes the `'ai-tool'` entry of `isApprover`, which better-supabase 0.9 reads. `holdersOf` and `actorMayWrite` are set whenever the manifest lists their helpers. The provider adds `functions.permitted`, `operations` and `delegation.scopes`, and the new `authorizationHooks` fills better-supabase's `AuthorizationHooks`. `subjectFromShareLink` refuses a share link pinned to a version.

| Before (0.4)                                                                | After                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authorizationProvider({ manifest, catalog, approver })` fills `canApprove` | The same call fills `isApprover` for the `'ai-tool'` kind. Set `rls.approvals`, run `permdock rls generate` and `permdock supabase inspect --out`, so the manifest lists `permdock_is_approver`; without it `isApprover` is unset and `problems` names the helper |
| better-supabase 0.8 read `canApprove` for AI tool approvals                 | better-supabase 0.9 calls `isApprover` for every request kind; pass `approvers: { "ai-tool": holder(p), … }` to name approvers for other kinds                                                                                                                    |
