---
"permdock": minor
---

Every adapter's options type now extends the exported `InstanceOptions`, so `approvalPolicies`, `relations`, `entitlements` and `policies` reach the instance from every adapter; before, the HTTP and agent adapters dropped `approvalPolicies`. The Hono, Express, Fastify, Elysia, Nest, Node, tRPC and oRPC adapters accept `actor`, and tRPC and oRPC accept `otel`.

Breaking: the `snapshots` option is removed from every server and agent adapter factory, which never read it. Delete it from the options object; a `SnapshotSource` such as `cloud().snapshots` goes to the `source` option of `permdock/react-native`.
