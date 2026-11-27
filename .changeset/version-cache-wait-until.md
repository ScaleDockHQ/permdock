---
"permdock": patch
---

`memoryVersionCache({ shared, waitUntil })` hands each write and delete to the shared version store to `waitUntil`. The cache does not await those writes, so on a serverless host they could be frozen with the instance after the response and never land; every instance then missed the store and read the version from the database. Pass `waitUntil` from `@vercel/functions` (or the platform's equivalent).
