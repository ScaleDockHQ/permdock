---
"permdock": minor
---

`permdock gen` writes only the kinds that `gen.kinds` or `--kind` lists. `types` and `sql` are now kinds of their own, with `types()` and `sql()` plugins in `permdock/cli/plugins/app`, and `constants` writes only `constants.ts` (and `fields.ts` with `gen.fields`). Before, `constants` also wrote `types.ts` and the `server-only` `sql.ts`, so an app that listed only `constants` and `react` got two modules nobody imported. `zod`, `valibot` and `factories` add `types`, which they import. With no `gen.kinds`, `gen` still writes `constants`, `types` and `sql`. An app that imports `sql.ts` or `types.ts` and sets `gen.kinds` adds `sql` or `types` to it; a `plugins` config adds `sql()` or `types()`.
