# pnpm catalog

Every external dependency is an exact pin in the `catalog` of `pnpm-workspace.yaml`; `package.json` files say `catalog:`.

- Add with `pnpm add <name>` in the workspace, or `pnpm add -w -D <name>` at the root. pnpm writes the catalog entry and picks the newest version older than `minimumReleaseAge` (1440 minutes). Never lower or bypass that gate.
- Look versions up at run time with `pnpm view <name> version`; do not trust a version from memory.
- A workspace package added with `pnpm add` lands in the catalog as `workspace:*` and in `package.json` as `catalog:`. Remove the catalog line and write `"workspace:*"` in `package.json` by hand.
- `pnpm add` prunes catalog entries that no workspace uses any more. Check `git diff pnpm-workspace.yaml` after every add and restore anything removed by mistake.
- Insert new catalog lines in place. Re-sorting the whole catalog rewrites unrelated lines.
- Never undo someone else's uncommitted `package.json` edits with `git checkout --`: they may hold dependencies not yet committed.
- To develop against an unpublished sibling release, point its catalog line at `link:../<repo>/packages/<name>` and never commit that line. While it is in place, export `pnpm_config_strict_peer_dependencies=false pnpm_config_verify_deps_before_run=false` for every command, hooks included. Otherwise the peer range fails the install, and the dependency check reinstalls the published version whenever the lefthook stash hides the link, so lint runs against the old types.

## Pre-release pins

- `@orpc/server`, `@orpc/client`, `@orpc/contract`, `@orpc/openapi` 2.0.0-beta.47: `permdock/orpc` targets oRPC 2's `openapi()` metadata.
- `drizzle-orm` 1.0.0-rc.5: the release candidate the standard asks for; the peer also accepts 0.40.
- `@supabase/pg-delta` 1.0.0-alpha.60, `pg-topo` 1.0.0-alpha.8: Declarative Schemas 2.0 for `tests/integration` and `db diff`.
- Prisma 8 and Expo SDK 58 stay on 7.10.0 and SDK 57 until their blockers clear (0018).

Why a lockfile entry exists: `pnpm why <name>`; never open `pnpm-lock.yaml` to answer it.
