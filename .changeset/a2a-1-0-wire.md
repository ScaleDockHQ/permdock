---
"permdock": patch
---

`permdock/a2a` emits Agent Cards in the A2A 1.0 wire form, and the cards validate against the published `a2a.json`. The card URL moves into `supportedInterfaces`, security schemes use the one-of form (`oauth2SecurityScheme`), skill requirements become `{ schemes: { name: { list } } }`, and skills carry `tags`. The card also fills `description`, `capabilities` and the default input and output modes. `securitySchemes` keeps its OpenAPI-style input with a typed `type`. `sign(card, signPayload)` now returns the card with a detached RFC 8785 JWS appended to `signatures`, instead of `{ card, signature }`.
