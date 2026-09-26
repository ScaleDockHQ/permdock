---
'@permdock/cli': patch
---

`createPermDockPlugin()(config)` accepts a config typed as Next's `NextConfig` interface; the `NextConfigLike` constraint no longer requires an index signature.
