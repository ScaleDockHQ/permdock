---
"permdock": minor
---

`claimsFirst(sources, { version, onStale: 'reread' })` re-reads the memberships from the sources when the token's `authzVersion` is behind the source's `version`, or absent, instead of keeping the token's memberships and denying `fresh` permissions. A token minted before a new membership or contact link then sees it on the next request without the application rebuilding the instance. A fresh token costs one `version` read and no membership read; a `version` that throws keeps the token's memberships and marks the subject stale. The default, `onStale: 'deny'`, keeps today's behaviour.
