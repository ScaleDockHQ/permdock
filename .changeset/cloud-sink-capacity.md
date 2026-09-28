---
'permdock': patch
---

The `cloud()` sink bounds its re-queue while the Cloud is unreachable (`capacity`, default 10 000, oldest dropped first), matching `memorySink`.
