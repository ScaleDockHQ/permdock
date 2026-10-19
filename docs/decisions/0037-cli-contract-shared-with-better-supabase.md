# 0037. CLI contract shared with better-supabase

- Status: accepted
- Date: 2026-10-18

## Context

The standard's `references/cli.md` builds a CLI on citty with lazy subcommands, prints text or one JSON document under `--json`, exits `0`, `1` or `2`, and turns a missing value in a non-interactive run into exit `2`. better-supabase rebuilt its CLI on a shared contract: a static manifest, its own resolver, a result envelope, an agent mode and consent tokens. PermDock's CLI is used by the same coding agents in the same repositories, so the two CLIs should read and behave the same.

## Decision

`permdock` follows the contract better-supabase's CLI defines, which departs from `references/cli.md` in five places:

- **Exit codes.** `3` means action required (missing input, a login or the person's consent), `130` a cancelled prompt or SIGINT, `143` SIGTERM, beside `0`, `1` and `2`.
- **Missing input.** A run that cannot prompt and lacks a value returns `action_required` with `missing`, `choices` and `next`, and exits `3`, instead of exit `2`. Exit `2` stays for a command line that is wrong.
- **Agent mode.** When `--agent`, `PERMDOCK_AGENT` or the agent's environment says an agent runs the CLI, output defaults to JSON and prompts are off. `--no-json`, `--format text` and `--agent no` opt out.
- **The envelope.** `--json` prints `cli-result-v1` (`status`, `data`, `error`, `next`) for every command, success or failure, instead of a per-command document. `--help --json` prints `cli-commands-v1`.
- **Own resolver.** `src/cli/core/manifest.ts` lists every command and group, and `src/cli/core/run.ts` resolves and parses them. citty is no longer a dependency.

The product rationale (the flag vocabulary, consent and agent mode) is in the `Why` sections of `apps/docs/content/docs/cli/index.mdx` and `cli/agent-mode.mdx`.

## Consequences

- A script that checked for exit `2` on missing input sees `3`. 0.5.0 is the breaking release that carries it, with a changeset.
- The parser, help, completion and the docs-flags test have one source, the manifest, which PermDock maintains instead of citty.
- A change to the shared contract lands in both repositories. better-supabase publishes the contract in its decision 0047 (`docs/decisions/0047-cli-contract-for-other-clis.md`), which reserves `dirty_worktree` and `write_failed` as PermDock's own codes.
- `packages/permdock/tests/better-supabase/cli-contract.test.ts` checks PermDock against `cli-result-v1.json` from the pinned better-supabase release: every code is upstream, reserved or pending, a shared code keeps better-supabase's title and exit code, and the envelope validates against the published schema. A pending code that reaches the pin fails the test until it moves to the shared list.

## Alternatives considered

- **Stay on citty.** It has no subcommands with their own flags, no strict unknown-flag check and no machine-readable help, so each would be built around it.
- **Follow `references/cli.md` and update the standard later.** The two CLIs would diverge in the meantime, and agents would learn two contracts.
