---
"permdock": patch
---

The ceiling checks `permdock_api_key_allows`, `permdock_token_scope_allows` and `permdock_interactive_allows` are now PL/pgSQL. Each helper runs them once for every grant key it reads, and as SQL functions Postgres planned them again on every call, which for `permdock_token_scope_allows` also meant folding the whole scope map. A caller in many organizations with several grant keys per statement paid this most: in an adopting app, a single-row read behind a `permitted_<resource>_rows` set policy drops from 1.9 ms to 1.2 ms for an 11-organization admin. Run `permdock generate` to pick up the new helpers.
