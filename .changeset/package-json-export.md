---
"permdock": patch
---

`permdock/package.json` resolves through the exports map, so a tool can read the installed version without `ERR_PACKAGE_PATH_NOT_EXPORTED`.
