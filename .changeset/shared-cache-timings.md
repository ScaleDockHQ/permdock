---
"permdock": patch
---

`scripts/centrakit-latency.ts` measures the Server Action, the shared `bsb.kept` entry, `runtimeCacheVersionStore` and the cold instance on the CentraKit fixture; the Shared cache guide lists the before and after numbers, including 3 to 1 version reads for a Server Action that asks `database-write`.
