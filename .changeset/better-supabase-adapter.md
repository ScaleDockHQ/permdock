---
"permdock": minor
---

New `permdock/better-supabase` entry for better-supabase 0.6: `authorizationProvider({ manifest, catalog })` builds its `authorization` config from `permdock.manifest.json` and `permissions.catalog.json`, `bucketPolicy` and `topicPolicy` build its storage and realtime access policies from `Permission` references, `apiKeyVerifier` turns its API keys block into a `CredentialVerifier`, `apiKeyClaimOptions` reads its `api_key` claim settings from `rls.apiKeys`, and `subjectFromBetterSupabase` reads its sessions with the `features` claim as plans. `better-supabase` is an optional peer.
