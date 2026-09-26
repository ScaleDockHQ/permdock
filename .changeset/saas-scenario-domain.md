---
'@permdock/testing': minor
---

Add `@permdock/testing/saas`: a shared multi-tenant SaaS domain (`saasPermissions`, `saasRoles`, `saasPlans`, `saasPolicy`), an adversarial seed with `saasPrincipal`, Postgres schema and seed SQL, WebCrypto-signed ES256 fixture tokens, and hand-written `saasScenarios` every framework suite runs against. The entry imports neither Vitest nor Node built-ins, and the `vitest` peer is now optional.
