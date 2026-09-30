# Next.js builds

- Do not run `next build` and `pnpm typecheck` for the same app at the same time: both write `.next/types` and the loser reports missing files.
- `typecheck` reads `.next/dev/types` if it exists. When it reports routes that no longer exist, check that no dev server for this repository is running, then delete `apps/<app>/.next/dev/types`.
- Turbopack leaves `import.meta.dirname` undefined. Use `path.dirname(fileURLToPath(import.meta.url))`, with the `unicorn/prefer-import-meta-properties` override for that file.
- Both apps use `cacheComponents`. A page that reads files or other uncached data at build time needs `'use cache'`, or prerendering fails.
- A client component must not call `Math.random` or `Date.now` while rendering. Give `useChat` a fixed `id`.
- React 19.3 types deprecate `FormEvent`; use `SubmitEvent`.
- The docs build needs `packages/permdock` built first; `turbo run build --filter=docs` does that.
