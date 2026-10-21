---
"permdock": minor
---

`permdock` declares three dependencies instead of eight: `@standard-schema/spec`, `oxc-parser` and `jiti`. The CLI's `@clack/prompts`, `diff`, `smol-toml`, `package-manager-detector` and `fastest-levenshtein` are inlined into the CLI build, so an app that imports `permdock` no longer installs them.
