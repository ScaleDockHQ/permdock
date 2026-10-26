---
"permdock": minor
---

`protectServer` in `permdock/mcp` takes `onError(error, { permission, name })`, which receives a check that threw: a `data` loader, `decide`, an approval input or a subject a list cannot build. The call still refuses as PermDock built it, and a sink that throws is ignored.
