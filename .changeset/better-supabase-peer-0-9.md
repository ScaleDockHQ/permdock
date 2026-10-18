---
"permdock": minor
---

Breaking: the `better-supabase` peer range is `>=0.9.0 <0.10.0`, because `authorizationHooks` and the provider's `permitted`, `operations` and `delegation` fields exist only from 0.9. Upgrade better-supabase with `permdock`; until 0.9.0 is on npm, install it from its `main` branch.
