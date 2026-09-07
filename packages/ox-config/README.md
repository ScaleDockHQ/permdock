# @permdock/ox-config

Shared Oxlint and Oxfmt baselines for every package and app in this repository. Private, never published.

| Entry                        | Export          | Contents                                                                                                                                                                                              |
| ---------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@permdock/ox-config/oxlint` | `base`, `ignorePatterns` | Plugins (`eslint`, `unicorn`, `typescript`, `oxc`, `import`, `node`, `vitest`), every category except `style` and `nursery` at `error`, the no-eval rules from invariant 10, generic ignore patterns. |
| `@permdock/ox-config/oxfmt`  | `oxfmt(options)`         | `singleQuote`, `printWidth: 80`, `semi`, `trailingComma: all`, import sorting groups, `sortPackageJson`, generic ignore patterns. Accepts extra `ignorePatterns`; nothing else varies per workspace. |

Oxlint merges configs through `extends`. That merge covers `rules`, `plugins`, `categories` and `overrides`, but a consumer's `ignorePatterns` replaces the inherited list, so spread the exported constant in front of your own patterns:

```ts
// oxlint.config.ts
import { base, ignorePatterns } from '@permdock/ox-config/oxlint';
import { defineConfig } from 'oxlint';

export default defineConfig({
  extends: [base],
  ignorePatterns: [...ignorePatterns, 'generated/**'],
});
```

Oxfmt has no `extends`, so the entry is a factory:

```ts
// oxfmt.config.ts
import { oxfmt } from '@permdock/ox-config/oxfmt';

export default oxfmt({ ignorePatterns: ['generated/**'] });
```

Add `"@permdock/ox-config": "workspace:*"` to the consuming workspace's `devDependencies`.

What stays in the root config, not here:

- `options.typeAware: true`. Type-aware linting runs once from the root over the whole repository; `pnpm run lint` and `pnpm run fmt` are root scripts, not Turbo tasks.
- Repository-specific ignores (`.agents/**`, `.cursor/**`, `.claude/**`, the hand-written Markdown files at the root).
- The `packages/**` override that turns `import/no-default-export` back on for publishable code.
- The `apps/**` override that turns off restriction rules Next.js cannot satisfy (`async` Server Components, object spread, CSS side-effect imports).

The package ships TypeScript source (`src/*.ts`) directly. Oxlint and Oxfmt load `*.config.ts` through Node's type stripping, which follows the pnpm workspace symlink to the real path under `packages/`, so no build step is needed.
