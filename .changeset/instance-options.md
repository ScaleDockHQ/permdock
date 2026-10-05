---
"permdock": minor
---

Every adapter's options type now extends the exported `InstanceOptions`, so `approvalPolicies`, `relations`, `entitlements` and `policies` reach the instance from every adapter; before, the HTTP and agent adapters dropped `approvalPolicies`. The Hono, Express, Fastify, Elysia, Nest, Node, tRPC and oRPC adapters accept `actor`, tRPC and oRPC accept `otel`, and the never-read `snapshots` option is deprecated.
