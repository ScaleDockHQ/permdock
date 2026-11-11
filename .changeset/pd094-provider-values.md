---
"permdock": patch
---

PD094 reports `blocks.memberships.options.roleThrough` and `blocks.permissions.disabled.tenant` or `.user` only when the value equals what better-supabase would fill from the provider: a role source with the same `through`, or a suspension row under `blocks.permissions.model: "provider"`. A value that overrides the provider no longer fails the doctor, and a top-level `roleThrough` is no longer reported.
