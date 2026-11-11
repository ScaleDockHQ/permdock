---
"permdock": minor
---

Breaking: the CLI `--json` output follows better-supabase CLI contract 3 (`cli-result-v2.json`, replacing `cli-result-v1.json`): a failure prints one error document line on stderr with `reason`, `message`, `data`, `userActionRequired` and `retryable`, and nothing on stdout, and `next` steps carry `argv`. Exit code 3 is gone (`auth_required`, `input_required` and `confirmation_required` exit 2), `consent_required` with `--confirm <token>` is `confirmation_required` with `--yes --effects-digest <digest>`, and `dirty_worktree`, `write_failed` and `catalog_invalid` are `file_conflict` (exit 1), `failed` and `invalid_input`.
