---
"permdock": minor
---

`permdock/authzen` exports the rules its handler applies, so a hosted PDP answers the same: `parseAuthzenRequest(kind, body)` and `readAuthzenRequest(kind, request)` return the handler's 400 and 413 Problem Details in its order and wording; `readAuthzenPage` and `authzenPage` page search results; `searchActions(policy, user, resource)` decides every catalog permission of a resource type; and `searchSubjects(policy, lister, request)` filters the candidates an `AuthzenSubjectLister` answers. The `subjects` option is now typed `AuthzenSubjectLister`, and `list` receives `{ type, action, resource, context? }`; a `list()` that takes no argument still fits.
