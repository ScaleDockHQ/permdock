# `@permdock/example-monorepo`

Workspace pattern for colocated `definePermissions()` per package, `mergePermissions()` at the app root, and `permdock collect --check` on the committed catalog.

- `packages/posts` owns `post.*`
- `packages/billing` owns `billing.invoice.*` and `billing.plan.*`
- `src/permissions.ts` merges both trees
- `src/policy.ts` spreads role fragments from each package

```bash
pnpm --filter @permdock/example-monorepo test
```

That runs `permdock collect --check` against `permissions.catalog.json`. Re-run `pnpm exec permdock collect --cwd apps/examples/monorepo` after adding a permission.
