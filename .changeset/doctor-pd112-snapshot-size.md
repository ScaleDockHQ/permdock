---
"permdock": minor
---

`permdock doctor` reports PD112 as a warning when the snapshot of the role with the most grants is over 65,536 bytes of JSON, and names the largest part. `--only snapshot` runs it alone; the Next.js adapter page explains how to measure with `permdock snapshot size`. No generated SQL changes.
