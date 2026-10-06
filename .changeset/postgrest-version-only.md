---
"permdock": minor
---

The Supabase hook file now defines `authz_version_for(p_user uuid) returns bigint`, the authorization version `subject_for` reports without reading roles or memberships, under the same grants. `postgrestSources` takes `versionFn` (default `authz_version_for`) and `memberships.version` calls it, so `claimsFirst(sources.memberships, { onStale: 'reread' })` costs one cheap call per request and reads `subject_for` only when the token is behind. Regenerate the hook file and, when `permdock` is not an exposed schema, add a wrapper for the new function; until then `version` falls back to `subject_for` as before.
