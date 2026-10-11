---
"permdock": minor
---

`PermDockProvider` (and the Vue plugin, Svelte `setPermDock` and Solid provider) takes `defaults` for the `<Protected>` slots, `messages` for the new `useDescribe()` (`getDescribe()` in Svelte), and `onSnapshot`, `onClear` and `approvalInterval`. `<Protected approval>` renders an approval-required decision and falls back to `fallback`.
