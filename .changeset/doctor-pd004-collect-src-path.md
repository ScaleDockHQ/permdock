---
"permdock": patch
---

`permdock doctor` PD004 now compares the catalog on disk with the catalog `permdock collect` would write from `collect.srcPath`. Before, it built the comparison from `doctor.srcPath`, so a `doctor.srcPath` wider than `collect.srcPath` reported catalog drift that `permdock collect` could never clear. PD002 and PD003 still count the references under `doctor.srcPath`.
