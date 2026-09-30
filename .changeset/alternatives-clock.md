---
'permdock': patch
---

`decide()` evaluates a denial's `alternatives` at the `now` you pass, not the wall clock. With a pinned `now` and no sink or `on()` listener, a check reads no clock at all, so it runs in a prerendered React Server Component or Client Component under `cacheComponents`.
