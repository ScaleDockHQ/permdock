---
"permdock": minor
---

`schemas/cloud-api-v1.json` is the OpenAPI document of the PermDock Cloud API, including the `client_credentials` grant for callers of the hosted decision service, and `schemas/connector-v1.json` describes a connector. `testCloudApi(baseUrl, keys, options)` in `permdock/testing` runs the conformance runners and the HTTP contract checks against one Cloud environment and validates every response body against `cloud-api-v1.json`.
