# Contributing

Thanks for contributing to PermDock. This repository is a pnpm 12 + Turborepo monorepo. Public API changes start as an RFC-lite issue and land as an ADR. Maintainer rules live in [`AGENTS.md`](./AGENTS.md).

## Requirements

- Node.js 24 or later (24 LTS is what CI runs)
- pnpm 12.3.1 or later

npm and Yarn are not supported. Enable pnpm 12 with Corepack, or install it from the `next-12` tag (npm `latest` still points at pnpm 11):

```bash
corepack enable
corepack prepare pnpm@12.3.1 --activate
```

If Corepack cannot resolve pnpm 12:

```bash
npx get-pnpm next-12
```

## Setup

```bash
pnpm install
pnpm run check
```

`pnpm install` runs `lefthook install` via the `prepare` script so Git hooks are set up locally.

Useful scripts:

| Command              | What it does                              |
| -------------------- | ----------------------------------------- |
| `pnpm run check`     | Format check, Oxlint and typecheck        |
| `pnpm run fmt`       | Format with Oxfmt                         |
| `pnpm run lint`      | Lint with Oxlint                          |
| `pnpm run build`     | `turbo run build`                         |
| `pnpm run test`      | `turbo run test`                          |
| `pnpm run typecheck` | `turbo run typecheck`                     |
| `pnpm changeset`     | Add a changeset for a user-visible change |

## Adding a workspace

Every package and app extends the shared configuration instead of copying it:

- `tsconfig.json`: `"extends": "@permdock/typescript-config/library.json"` (packages), `react-library.json` (packages with `.tsx` entries) or `next.json` (Next.js apps). Add `"@permdock/typescript-config": "workspace:*"` to `devDependencies` and a `"typecheck": "tsc --noEmit"` script so `turbo run typecheck` picks it up.
- Linting and formatting run from the root over the whole repository, so a workspace normally needs no `oxlint.config.ts` or `oxfmt.config.ts`. If one does, extend `@permdock/ox-config/oxlint` and `@permdock/ox-config/oxfmt` as described in [`packages/ox-config/README.md`](./packages/ox-config/README.md).

## Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/). Lefthook runs commitlint on `commit-msg`.

Allowed types: `feat`, `fix`, `docs`, `chore`, `ci`, `refactor`, `test`, `perf`, `style`, `revert`. The subject is lower-case and the header is at most 72 characters.

```
feat: add membership source interface
docs: clarify fail-closed invariants
```

## Pull requests

- Open an [RFC issue](https://github.com/ScaleDockHQ/PermDock/issues/new?template=rfc.yml) before changing exported identifiers, wire formats, or CLI flags.
- Every user-visible change needs a changeset (`pnpm changeset`).
- Adapter work follows the checklist in [`AGENTS.md`](./AGENTS.md): docs page, `meta.json`, skill reference, example app, tests.
- Docs pages are Fumadocs MDX: frontmatter `title` and `description`, no `# h1`, and new pages must be listed in that folder's `meta.json`.

## Code of conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).

## Security

Do not open public issues for vulnerabilities. See [`SECURITY.md`](./SECURITY.md).
