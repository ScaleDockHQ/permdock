---
"permdock": minor
---

`permdock/server` exports `createServerKernel` with the `ServerKernel` and `ServerKernelOptions` types, the kernel every bundled HTTP adapter is built on. `memoryMembershipSource` and `memorySnapshotSource` join `memoryRoleSource` as in-process defaults, and `testMembershipSource` takes a `tenant` to pass to every `membershipsFor`.
