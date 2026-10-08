---
"permdock": minor
---

Breaking: `PermDockProvider` from `permdock/react-native` requires `subjectId`, the signed-in user's id or `null` when signed out. A stored snapshot is used only when its principal matches `subjectId`; `null` clears the storage. With a `verifier`, the provider stores the signed JWS and verifies it again at launch instead of storing the decoded snapshot. A stored copy starts with `status: 'stale'` until the first refresh. Storage that throws or rejects no longer breaks the provider. New `headers` no longer rebuild the store; the next refresh sends them. The interval pauses in the background, a return to the foreground refreshes, and the new `subscribeOnline` prop skips refreshes while offline.
