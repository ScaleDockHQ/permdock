---
"permdock": patch
---

`permdock doctor` PD092 reads only the `snapshots:` section of `pnpm-lock.yaml`, so a single copy of `permdock` no longer reports a second copy without peers from the `packages:` section.
