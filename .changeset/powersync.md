---
"permdock": minor
---

`permdock powersync generate` writes PowerSync Sync Streams (`sync-config.yaml`, edition 3) from the policy and `rls.memberships`, and `permdock powersync verify --db` fails when a stream syncs a fixture row the policy denies. A resource with a deny grant gets no stream, and doctor PD058 flags a stale file.
