---
"permdock": minor
---

`permdock doctor` adds PD125: `@supabase/pg-topo` reads the declarative schema directory and reports a dependency cycle, an object two schema files create, or a table `rls.tables` names that no schema file creates. It resolves pg-topo from the app, then from the installed `better-supabase`.
