---
"permdock": minor
---

`doctor.srcPath` sets the directories or globs `permdock doctor` reads for its source checks (PD001, PD002, PD007 to PD015, PD044 and the others over code), so client components outside `collect.srcPath` are checked without changing the catalog. It defaults to `collect.srcPath`; PD003 and PD004 still follow the catalog.
