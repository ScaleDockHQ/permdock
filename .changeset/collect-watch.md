---
"permdock": minor
---

`permdock collect --watch` collects again when a source folder, the config file or the configured `permissions` or `policy` module changes. The Next.js plugin and `permdock/unplugin` now pick up an edited `permissions.ts` instead of reusing its first import, ignore the catalog and barrel they wrote, and debounce reruns to one at a time.
