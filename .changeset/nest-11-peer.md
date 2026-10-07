---
"permdock": patch
---

The optional `@nestjs/common`, `@nestjs/core` and `@nestjs/platform-express` peers now accept Nest 11 (`>=11`). `permdock/nest` uses no API that is new in Nest 12, and CI runs its unit and integration suites against Nest 11 as well. An app that carries Nest 11 through another dependency no longer gets `ERR_PNPM_PEER_DEP_ISSUES`.
