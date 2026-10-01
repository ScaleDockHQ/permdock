---
'permdock': patch
---

Bound the work one request can cause. `can` and `whoCan` walk each nested group once per depth budget, so a lattice of shared teams costs time in its group count rather than its path count. `createEvaluationsHandler` (and `permdockHandler`) answers a batch over `maxEvaluations` (256 by default, the AuthZEN limit) with a 413 Problem Details before resolving the subject. A denial's `alternatives` peek a quota grant's `remaining` without spending it, and `can` skips alternatives entirely.
