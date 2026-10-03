# @permdock/typescript-config

Shared `tsconfig` presets for every package and app in this repository. Private, never published.

| Preset               | Extends        | Use for                                                                                                                                  |
| -------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `base.json`          | —              | The strict baseline: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `nodenext`, ES2024, `noEmit`. Root config files. |
| `library.json`       | `base.json`    | Publishable packages built with tsdown. Adds `declaration` and `isolatedDeclarations` so `.d.ts` emit never needs the compiler API.        |
| `react-library.json` | `library.json` | Packages with `.tsx` entries (`permdock/react` and friends). Adds `jsx: react-jsx` and the DOM libs.                                       |
| `next.json`          | `base.json`    | Next.js apps (`apps/docs`, `apps/examples/next`). Bundler resolution, `allowJs` with `checkJs`, `incremental`, the `next` language-service plugin.        |

Usage:

```json
{
  "extends": "@permdock/typescript-config/library.json",
  "compilerOptions": {
    "types": ["node"]
  },
  "include": ["src"]
}
```

Add `"@permdock/typescript-config": "workspace:*"` to the package's `devDependencies`. Presets never set `include`, `outDir`, `rootDir`, `paths` or `types`; those belong to the consuming package.

## Why these settings

- **TypeScript 5.9, 6 and 7 are all supported.** `tests/types` runs the type tests against each version. The public API avoids template-literal unions partly so TypeScript 7 stays fast, and no preset uses a `moduleResolution` mode that TypeScript 6 removed.
- **`isolatedDeclarations` in every package.** TypeScript 7 is a native compiler with no stable programmatic API until 7.1, so declaration emit must not depend on the compiler API. With `isolatedDeclarations`, tsdown emits `.d.ts` files without type-checking, and exported functions carry explicit return types, which also makes generated docs and skills more precise and keeps declaration files fast to load. Apps extend `next.json`, which does not set it, because they publish no declarations.
- **`erasableSyntaxOnly` everywhere.** Node's type stripping, Bun and Deno run source that uses only erasable syntax, so there are no enums, namespaces, parameter properties or `import x = require`.
- **Codegen never loads the compiler.** `permdock collect`, `openapi` and `rls` parse with `oxc-parser` and read runtime definitions, for the same TypeScript 7 reason.
- **`strict` everywhere**, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`: subject narrowing and the instance-versus-collection arity checks rely on strict null checks.
