## What ships

<!-- One or two sentences a user would understand: the entry, identifier, command or page, and the behaviour change. Link the RFC issue for public API changes. -->

## Verify

<!-- Commands a reviewer can run and what they print, or the test that covers it. -->

```bash
pnpm run verify
```

## Checklist

- [ ] `pnpm run verify` passes
- [ ] User-visible change has a changeset (`pnpm changeset`); CI-only changes do not
- [ ] Rows in `.agents/rules/change-checklist.mdc` that match this change are done (docs page, `meta.json`, skill, example, tests)
- [ ] Docs changes pass `pnpm docs:drift`
- [ ] Prose follows `.agents/rules/writing.mdc`
