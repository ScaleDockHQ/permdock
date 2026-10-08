---
"permdock": patch
---

`permdock/vue`, `permdock/svelte` and `permdock/solid` re-run a check when a reactive row changes in place again; only `permdock/react` reuses decisions within a render pass. In every UI adapter, a throwing subscriber no longer stops the others from seeing a logout. Approval polls also back off on errors and stop after a 4xx or five failures, and a snapshot for another user drops the previous user's approval state.
