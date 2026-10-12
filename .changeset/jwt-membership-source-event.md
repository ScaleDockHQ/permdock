---
"permdock": patch
---

`subjectFromJwt` and `createJwtSubjectResolver` report a throwing `memberships` source through `onAuth` as `{ reason: 'source-threw', source: 'memberships' }`. The subject still resolves without the extra memberships.
