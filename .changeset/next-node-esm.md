---
"permdock": patch
---

`permdock/next` and `permdock/next/client` now load in plain Node ESM, such as Vitest with `permdock` external or a Node script, instead of failing with `ERR_MODULE_NOT_FOUND` for `next/cache`. The entries import Next.js modules by file and route `next/navigation` through the package import `#next/navigation`, so Next.js still resolves its server build under `react-server`.
