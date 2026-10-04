# @permdock/ox-config

Shared Oxlint and Oxfmt baselines for every package and app in this repository. Private, never published.

| Entry                        | Exports                                                                                         | Contents                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@permdock/ox-config/oxlint` | `core`, `library`, `node`, `test`, `react`, `example`, `oneLibraryPerConcern`, `ignorePatterns` | Composable presets. `core` holds the plugins, the categories at `error`, the type-aware rules, the no-eval rules from invariant 10 and the bans on Radix, vaul and date libraries (dates use `Temporal`); the others add the rules for one kind of code. `oneLibraryPerConcern` is a rules object for the apps that allow one library per concern.                       |
| `@permdock/ox-config/oxfmt`  | `oxfmt(options)`                                                                                | Double quotes, `printWidth: 80`, `semi`, `trailingComma: all`, import sorting groups, `sortPackageJson`, `sortTailwindcss` for `cn`, `cva` and `tv`, generic ignore patterns. Formats Markdown and MDX too. Accepts extra `ignorePatterns` and `tailwindStylesheets` (each app's Tailwind entry stylesheet, so theme tokens sort as known classes); nothing else varies. |

Every workspace has its own `oxlint.config.ts` and a `lint` script, `oxlint --disable-nested-config`, that Turbo runs; the root config covers only the root tooling files (`pnpm run lint:root`). Oxlint merges configs through `extends`. That merge covers `rules`, `plugins`, `categories` and `overrides`, but a consumer's `ignorePatterns` replaces the inherited list, so spread the exported constant in front of your own patterns:

```ts
// oxlint.config.ts
import {
  core,
  library,
  test,
  ignorePatterns,
} from "@permdock/ox-config/oxlint";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [core, library, test],
  ignorePatterns: [...ignorePatterns, "generated/**"],
});
```

Oxfmt has no `extends`, so the entry is a factory:

```ts
// oxfmt.config.ts
import { oxfmt } from "@permdock/ox-config/oxfmt";

export default oxfmt({ ignorePatterns: ["generated/**"] });
```

Add `"@permdock/ox-config": "workspace:*"` to the consuming workspace's `devDependencies`.

oxlint accepts `typeAware` only in the root config, so the repository-root `oxlint.config.ts` sets it and each workspace's `lint` script passes `--type-aware`; no preset sets it. Type-aware rules read the nearest `tsconfig.json`, so a workspace's lint sees the same compiler options as its typecheck.

The package ships TypeScript source (`src/*.ts`) directly. Oxlint and Oxfmt load `*.config.ts` through Node's type stripping, which follows the pnpm workspace symlink to the real path under `packages/`, so no build step is needed.
