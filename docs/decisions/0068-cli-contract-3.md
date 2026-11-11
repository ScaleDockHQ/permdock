# 0068. PermDock moves to better-supabase's CLI contract 3

- Status: accepted
- Date: 2026-11-11
- Amends: the exit codes, missing input, envelope and consent of 0037

## Context

Decision 0037 makes `permdock` follow better-supabase's CLI contract. better-supabase 0.58 ships CLI contract 3 ([0.57 to 0.58 guide](https://bettersupabase.com/docs/migration/0.57-to-0.58#cli)):

- `cli-result-v2.json` replaces `cli-result-v1.json`. A result prints on stdout; a failure prints one error document line on stderr (`reason`, `message`, `type`, `next`, `data`, `userActionRequired`, `retryable`) and nothing on stdout. A report that exits 1 keeps its data on stdout.
- Exit code 3 is gone: `auth_required`, `input_required` and `confirmation_required` exit 2 with `userActionRequired: true`.
- `consent_required` is `confirmation_required`, and `--confirm <token>` is `--yes --effects-digest <digest>`, with `digest` and `effects` in `data`.
- A `next` step carries `argv` next to `command`.
- The `reason` enum is closed. PermDock's own codes `dirty_worktree`, `write_failed` and `catalog_invalid` are not in it.

## Decision

- `permdock --json` prints `cli-result-v2` (`schemas/cli-result-v2.json`, `$id` `https://permdock.com/schemas/cli-result-v2.json`) with contract 3's shape, routing and exit codes. `cli-result-v1.json` is deleted; the package ships one current format.
- Every `reason` is one of better-supabase's, with its exit code. `dirty_worktree` becomes `file_conflict` (exit 1), `write_failed` becomes `failed`, `catalog_invalid` becomes `invalid_input` with `data.issues` as `path: message` lines, and the removed `--confirm` answers `flag_renamed`.
- The consent digest keeps PermDock's inputs (the reasons, the working directory and the command line without global flags) and contract 3's flags: a run is confirmed only with `--yes` and the matching `--effects-digest`.
- A Cloud answer's own Problem Details `type` moves to `data.cloudProblem`, because the document's `type` links to the errors page.
- `packages/permdock/tests/better-supabase/cli-contract.test.ts` validates PermDock's documents against the pinned `better-supabase/schemas/cli-result-v2.json` and holds every reason and exit code to the pinned `CliError`. It has no list of differences.
- `--help --json` stays on `cli-commands-v1`; better-supabase's `cli-commands-v2` is a separate change.

## Consequences

- An agent that drives both CLIs reads one contract.
- A script that read `error` from stdout, branched on exit 3 or passed `--confirm` breaks. The `permdock` changeset marks the release as breaking and lists each change.
- better-supabase's decision 0047 reserves `dirty_worktree` and `write_failed` for PermDock; PermDock no longer raises either.

## Alternatives considered

- Keep `cli-result-v1` and exit 3: agents would read two contracts, and the contract test would keep a growing list of known differences.
- Keep PermDock's own reasons outside the upstream enum: the documents would no longer validate against better-supabase's schema, which is the point of sharing it.
