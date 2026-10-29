---
"permdock": minor
---

`permdock powersync generate` now joins a composite roles junction (a `through` with more than one `on` pair, such as better-supabase `roles: "many"`) on every pair and selects an `id` for its rows; before, it joined on the first pair, so a member could sync another member's role, and PowerSync dropped the rows for want of an `id`. `powersync verify` checks the junction stream for leaks. On the device, `readRows` matches the junction on every pair and keeps every role; the device manifest's `through` gains an additive `on`. Rerun `permdock powersync generate`.
