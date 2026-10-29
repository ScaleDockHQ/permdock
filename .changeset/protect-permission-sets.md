---
"permdock": minor
---

`protect` in `permdock/orpc`, `permdock/trpc` and the server kernel takes a permission list: every permission by default, one with `anyOf: true`. The `rows` option loads many rows in place of `data`; every row must be granted, a denial reports the first denied row, `permdockData` holds the rows, and no rows answers 404. `openapi.security`, `openapi.spec` and the oRPC `permissionOf` take or return the list; `permissionOf` now returns `Permission | readonly Permission[] | undefined`.

Wire change: the Problem Details `detail` of a denial no longer names the subject. `"post.delete denied for subject u_123: member (condition)."` is now `"post.delete denied: member (condition)."`; the subject id stays in the error `message` and the audit event. A client that parsed the subject out of `detail` reads it from its own session. `problemFromDecision` ignores its `subject` argument.
