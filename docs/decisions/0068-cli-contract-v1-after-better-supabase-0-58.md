# 0068. PermDock keeps CLI contract v1 after better-supabase 0.58 moves to contract 3

- Status: accepted
- Date: 2026-11-11
- Amends: the shared envelope and exit codes of 0037

## Context

Decision 0037 makes `permdock` follow better-supabase's CLI contract, and `packages/permdock/tests/better-supabase/cli-contract.test.ts` checked PermDock's `--json` output against `better-supabase/schemas/cli-result-v1.json` from the pinned release. better-supabase 0.58 ships CLI contract 3 ([0.57 to 0.58 guide](https://bettersupabase.com/docs/migration/0.57-to-0.58#cli)):

- `cli-result-v1.json` and `cli-commands-v1.json` are gone; `cli-result-v2.json` and `cli-commands-v2.json` replace them.
- A failure prints the error document on stderr with `reason` and `message`, and nothing on stdout. v1 printed `error.code` and `error.detail` on stdout.
- Exit code 3 is gone: an action-required run exits 2 with `userActionRequired: true`. PermDock's `auth_required` and `input_required` exit 3.
- `consent_required` is `confirmation_required`, and `--confirm <token>` is `--yes --effects-digest <digest>`.

The titles of every code both CLIs share still match. Moving PermDock to contract 3 changes its output, exit codes, a problem code and a flag, which is a breaking CLI release of its own and not part of the 0.58 peer move.

## Decision

- `permdock` keeps the `cli-result-v1` envelope, exit code 3 and `consent_required` with `--confirm <token>`.
- `packages/permdock/tests/fixtures/better-supabase/cli-result-v1.json` is the v1 schema better-supabase 0.57.0 published, unchanged. The contract test validates PermDock's envelope against it.
- The contract test reads the codes from the pinned `cli-result-v2.json` `reason` enum and the titles and exit codes from the pinned `CliError`. It lists the known differences: `consent_required` renamed upstream, and `auth_required` and `input_required` exiting 3 where contract 3 exits 2. A new difference fails the test.

## Consequences

- An agent that drives both CLIs reads two contracts until PermDock adopts contract 3: errors on stdout from `permdock`, on stderr from `better-supabase`.
- Adopting contract 3 is a separate change with a breaking changeset. It deletes the fixture, the rename list and the exit-code list from the contract test, and supersedes this record.

## Alternatives considered

- Adopt contract 3 in the 0.58 peer move: it mixes a CLI break into a provider release and touches every command's output and help snapshots.
- Drop the envelope check: nothing would stop PermDock's own envelope from drifting from the shape it claims to follow.
