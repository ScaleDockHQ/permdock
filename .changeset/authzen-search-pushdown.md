---
"permdock": minor
---

AuthZEN `search/resource` hands `resources.<type>.list` the compiled `access` condition, the page `limit` and the request's `page.token` as `cursor`, and skips `list` when the action reaches no row. A `list` that answers `{ rows, next }` makes its own pages; the handler still decides every row, and the page answers `next_token` from `next` with no `total`. An array answer is paged in memory as before.
