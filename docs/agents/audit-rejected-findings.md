# Rejected audit findings

Findings an audit raised and rejected after checking the code. Read this before an audit so it does not reopen them; add a line when a finding is rejected with a reason.

- `map-claims.ts` handles `invalidClaims` differently in `subjectFromJwt` and `subjectFromIntrospection`, but the behaviour is the same: the claims are dropped and the principal is kept.
- `notIn` NULL semantics are identical in `src/conditions/evaluate.ts`, the NNF negation in `src/conditions/compile.ts` and the SQL translation in `src/cli/sql/conditions.ts`.
- A `WeakMap` cache so `subjectFromJwt` reuses its verifier is module-level mutable state, which invariant 7 forbids. The guidance steers servers to one verifier instead.
- `matchWriteScope`'s asymmetric deny handling is the correct fail-closed behaviour.
- `use()` called conditionally in `src/react/hooks.ts` is allowed by React.
- `$/` same-repo GitHub Actions in `.github/workflows` are deliberate (commit `d541f9cd`).
- A break-glass deny stays in `trace.denies` when the grant lifts it, as `concepts/decisions.mdx` documents ("or the deny a break-glass grant lifted").
- Moderate `pnpm audit` advisories in transitive dev dependencies (`uuid`, `decode-uri-component`, `fast-uri`, `ip-address`) are below the `--audit-level high` gate. `auditConfig` in `pnpm-workspace.yaml` documents the ignored HIGH advisories.
- `//#lint:root` in `turbo.json` is not dead: `lefthook.yml` runs `turbo run lint:root` on push.
