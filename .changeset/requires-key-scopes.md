---
"permdock": minor
---

A delegated caller (an OAuth client or an API key) whose scopes name a permission an allow `requires`, but not the granted permission itself, may now use that allow and only that one. Keys stored with a feature scope such as `file:read` keep reading the drives a `requires: file.read` share reaches after an app moves `drive.read` to relation grants, without reissuing the keys. `permdock rls generate` with `rls.apiKeys` accepts the required key in the `api_key` claim the same way.
