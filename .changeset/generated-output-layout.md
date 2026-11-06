---
"permdock": minor
---

`permdock generate` writes typed modules to `src/permdock/` with one file per kind and no barrel: `constants.ts`, `types.ts`, `sql.ts` (server-only), `zod.ts`, `valibot.ts`, `arktype.ts`, `json-schema.json`, `standard-schema.ts`, `factories.ts`, `messages.json`, `react.ts`, `vue.ts`, `svelte.ts`, `solid.ts`. Every name is one export per unit (`orgQuotesTopic`, `quoteFilesPath`, `permittedOrganizationIds`, `projectFactory`), so a bundler drops what a page does not import, and every schema constructor carries `/* @__PURE__ */`. `gen.zod.specifier: "zod/mini"` writes the functional Zod API, `gen.fields` replaces `gen.fieldMeta` and writes `fields.ts`, and `permdock/testing` adds `sequence`, `resetFactories`, `idOf`, `factoryUuid` and `factoryText`. Every module starts with a header naming the plugin version, the policy and a model digest. `permdock codemod 0.26` rewrites imports of the old files and `gen.fieldMeta`.

| Old                                                                       | New                                                  |
| ------------------------------------------------------------------------- | ---------------------------------------------------- |
| `permdock.generated.ts`                                                   | `constants.ts`, `types.ts`, `sql.ts`                 |
| `permdock.zod.ts`, `permdock.valibot.ts`, `permdock.arktype.ts`           | `zod.ts`, `valibot.ts`, `arktype.ts`                 |
| `permdock.schemas.ts`, `permdock.schemas.json`                            | `standard-schema.ts`, `json-schema.json`             |
| `permdock.factories.ts`, `permdock.react.ts`, `permdock.svelte-stores.ts` | `factories.ts`, `react.ts`, `svelte.ts`              |
| `scopes`, `roles`                                                         | `scopeNames`, `roleNames`                            |
| `topics.<name>`, `paths.<name>`                                           | `<name>Topic`, `<name>Path`                          |
| `sqlNames.*`                                                              | one export per helper in `sql.ts`, `<resource>Table` |
| `factories.<resource>`, `factories.subject`                               | `<resource>Factory`, `subjectFactory`                |
| `AppVocabulary`, `AppScope`, `AppRolesOptions`                            | `Vocabulary`, `ScopeName`, `RolesOptions`            |
| `gen.fieldMeta`, `<resource>Fields` inside each validator file            | `gen.fields`, `fields.ts`                            |
| `gen.out` default `src/generated`                                         | `src/permdock`                                       |
