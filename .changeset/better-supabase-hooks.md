---
"permdock": minor
---

Breaking: `authorizationProvider` from `permdock/better-supabase` drops the `functions` option and never sets `canApprove`; `holdersOf` and `actorMayWrite` are set whenever the manifest lists their helpers, and `approver` becomes the `'ai-tool'` entry of `isApprover`. The provider adds `functions.permitted`, `operations` and `delegation.scopes`, and the new `authorizationHooks` fills better-supabase's `AuthorizationHooks`. `subjectFromShareLink` refuses a share link pinned to a version. These need better-supabase's `main` branch until its next release.
