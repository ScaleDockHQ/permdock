---
'permdock': patch
---

The package carries the `tanstack-intent` keyword. Internal non-null assertions and `any` flows in the core, conditions, CLI and adapters are replaced with checked narrowing; the PDP adapters' granted decision now fails closed with `anonymous` when a subject has no principal instead of asserting one.
