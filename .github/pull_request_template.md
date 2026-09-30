## What

<!-- One or two sentences a user would understand: the entry, identifier, command or page, and the behaviour change. Link the RFC issue for public API changes. -->

## Verify

<!-- Commands a reviewer can run and what they print, or the test that covers it. -->

```bash
pnpm verify
```

## Checklist

- [ ] `pnpm verify` passes
- [ ] User-visible change has a changeset (`pnpm changeset`); CI-only changes do not
- [ ] A new env key is in the app's `env.ts`, `.env.example`, `turbo.json` and Vercel; secrets are not `NEXT_PUBLIC_*`
- [ ] Rows in `AGENTS.md` "When you change X" and `.agents/rules/change-checklist.mdc` that match this change are done (docs page, `meta.json`, skill, example, tests)
- [ ] No invariant in `.agents/rules/invariants.mdc` is broken
- [ ] Docs changes pass `pnpm docs:drift`
- [ ] Prose follows `.agents/rules/writing.mdc`
