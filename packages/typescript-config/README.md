# @permdock/typescript-config

Shared `tsconfig` presets for every package and app in this repository. Private, never published.

| Preset               | Extends        | Use for                                                                                                                                  |
| -------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `base.json`          | —              | The strict baseline: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `nodenext`, ES2024, `noEmit`. Root config files. |
| `library.json`       | `base.json`    | Publishable packages built with tsdown. Adds `declaration` and `isolatedDeclarations` so `.d.ts` emit never needs the compiler API.        |
| `react-library.json` | `library.json` | Packages with `.tsx` entries (`permdock/react` and friends). Adds `jsx: react-jsx` and the DOM libs.                                       |
| `next.json`          | `base.json`    | Next.js apps (`apps/docs`, `apps/examples/next`). Bundler resolution, `allowJs`, `incremental`, the `next` language-service plugin.        |

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

Rationale lives in [ADR 0016](../../apps/docs/content/docs/decisions/0016-repo-layout-and-toolchain.mdx): TypeScript 5.9, 6 and 7 are supported, `isolatedDeclarations` and `erasableSyntaxOnly` are enabled in every package, and no `moduleResolution` mode that TS 6 removed is used.
