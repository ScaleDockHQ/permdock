---
"permdock": patch
---

`permdock/webmcp` now validates instance-tool arguments against the resource schema when `registerTools` is given a resource node such as `permissions.post`, or a nested group, as the docs show. Before, the schema was found only from the root tree, so agent input went unvalidated. Collection actions no longer pick up the resource schema, and an explicit `schema` option now overrides it.
