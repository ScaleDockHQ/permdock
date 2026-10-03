---
"permdock": minor
---

`permdock/terminal` asks for the resource id to be typed before running a `destructive` permission (replace the prompt with `interactive: { typed }`), and without a terminal exits with the new `EX_USAGE` (64) unless `--yes` or `-y` is passed or the `yes` option is set. `--dry-run` (or `dryRun: true`) decides as a simulation, prints the decision and exits with its code without running the action or consuming a limit. The `ci-oidc` token source takes `{ source: 'ci-oidc', audience }` to request a GitHub Actions audience and `{ source: 'ci-oidc', env }` to read a GitLab `id_tokens` variable. `permdock/jwt` adds `subjectFromCiOidc(token, { provider, audience, issuer?, schema? })` for GitHub Actions, GitLab CI and Buildkite tokens, returning a `workload` principal with `repository`, `ref` and `environment`, never a user.
