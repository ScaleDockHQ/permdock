---
"permdock": patch
---

`permdock/fastify`: the `permdockHandler` decision endpoint reuses the subject the `permdock` plugin resolved for the request, so `subject` runs once per request, as it does in Express, Node and Nest.
