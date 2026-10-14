---
"permdock": minor
---

Breaking: `subjectFromApiKey` loads a user key's owner through a `PrincipalSource` passed as `principals`, asked with the key's tenant, instead of an `owner(id)` callback.

| Before                         | After                               |
| ------------------------------ | ----------------------------------- |
| `subjectFromApiKey({ owner })` | `subjectFromApiKey({ principals })` |
