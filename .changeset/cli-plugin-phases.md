---
'@permdock/cli': minor
'permdock': minor
---

`createPermDockPlugin` now returns Next's config function and reads the phase Next passes in: `next build` runs `collect --check` and rejects on drift (unless `onDrift: 'warn'`), `next dev` writes once and starts one watcher per app root. It accepts a config object or function; put it outermost when composing with plugins that expect an object. `createPermDockUnplugin` awaits collect in `buildStart`, gains `check`, and logs watch failures instead of crashing. `srcPath` globs now match segment by segment, skip `node_modules` and `dist` unless the pattern names them, and dedupe files reached through workspace symlinks.
