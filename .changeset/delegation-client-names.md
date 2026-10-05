---
"permdock": minor
---

A policy delegation can name an OAuth client by a stable name, `to: { kind: 'oauth-client', client: 'cli' }`, instead of its id. `subjectFromSupabase`, `permdock/mcp` (`createPermDock` and `subjectFromMcp`) and `subjectFromJwt`'s `actor` option take `clients` (`ClientNames`: a record from name to id, or a function from a verified id to a name) and set `actor.client`. An id the mapping does not name, or names twice, leaves `client` unset and the delegation does not apply. The catalog's delegation `to` gains `client`.
