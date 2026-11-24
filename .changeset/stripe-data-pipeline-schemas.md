---
"permdock": patch
---

`permdock rls verify --introspect` and `permdock rls report` treat Stripe Data Pipeline schemas (`stripe_sdp…`, owned by the `stripe_sdp` role) as platform schemas and leave their policies out.
