---
"permdock": minor
---

`permdock/testing` adds `memoryPostgrestSources` and `rolePersonas`, which read `defineSeeds` fixtures without a database. `permdock rls verify --kind pgtap --personas roles` writes one pgTAP persona per role the fixtures hold. CASL and Casbin imports emit `defineSeeds` defaults with the policy.
