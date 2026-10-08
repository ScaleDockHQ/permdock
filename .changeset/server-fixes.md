---
"permdock": patch
---

`permdockExtension` from `permdock/prisma` now scopes `findFirstOrThrow` and `groupBy`. `verifyDpopProof` from `permdock/jwt` compares `htu` without the request's query and fragment, per RFC 9449 section 4.3. A new `replay` option on `createJwtSubjectResolver` with `sender: "dpop"` rejects a reused proof `jti`, and `memoryReplayStore` is exported from `permdock/jwt`.
