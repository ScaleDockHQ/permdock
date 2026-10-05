---
"permdock": minor
---

New command `permdock config` warns on config keys PermDock does not read, and `--print` prints the effective config with every default. Every command now exits `2` when a module path or a config section has the wrong type. Under `--json`, a non-zero exit always prints JSON: a text failure such as `collect --check` drift becomes Problem Details with `type` `https://permdock.com/problems/cli-failed`. `doctor` loads the policy and scans the sources once per run. It reports a policy module that fails to load as `PD059` and a source file that does not parse as `PD060`.
