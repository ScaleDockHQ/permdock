---
"permdock": patch
---

UI stores key endpoint answers for a row without an id by its content and read the row id from the snapshot's `ids` field, so two such rows no longer share one answer. `useApproval` polling resumes when a component subscribes again after a StrictMode or remount unsubscribe. `<Protected tenant>` renders `pending` while the provider's snapshot is on its way. `PermDockProvider` keeps its store in state, so React never rebuilds it for unchanged props.
