---
"permdock": minor
---

`permdock/better-supabase`: `bucketPolicy` and `topicPolicy` accept `{ policy, schema?, scope, segment? }` besides `{ manifest, catalog, scope, segment? }`. With the `definePolicy` result the app already imports, no manifest or catalog is read at runtime: the scopes, the permissions with row conditions and the scopes a permission is granted at come from the policy, and `schema` names the helper schema (default `permdock`). The same keys are refused as before.
