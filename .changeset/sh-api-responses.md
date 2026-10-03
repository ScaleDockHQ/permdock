---
"permdock": minor
---

HTTP adapters answer an exhausted `limit` with `429`, `Retry-After` and the `RateLimit` / `RateLimit-Policy` fields of `draft-ietf-httpapi-ratelimit-headers-11`, and `limit-unavailable` with `503`; tRPC and oRPC map them to `TOO_MANY_REQUESTS` and `SERVICE_UNAVAILABLE`. A `limit` denial now carries `detail: { count, window, resetsAt }` (`LimitDetail`). `resource()` takes `disclosure: 'hide'`, which makes a denied row answer the same `404` `/not-found` problem a missing row gets; a missing row is now that problem instead of an empty `404`. A step-up challenge names `acr_values` and `max_age` in `WWW-Authenticate` and `acrValues` / `maxAge` in the body, including the requirements of break-glass grants and role activations, whose denials now carry the `assurance` grantee in `to`. `permdock doctor` PD036 warns on a `protect(permission)` with no row loader on a route whose path names an id.
