---
"permdock": patch
---

`permdock doctor` PD005 looks for the skills and their lock in the working directory and every directory above it up to the workspace root, and accepts the `skills` CLI's `skills-lock.json` when it lists the `permdock` skill, so a package in a monorepo whose skills are installed at the root no longer reports them missing.
