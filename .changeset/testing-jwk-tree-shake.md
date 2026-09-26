---
'@permdock/testing': patch
---

`@permdock/testing/saas` declares its test JWKs as plain literals instead of module-level `Object.freeze` calls, so client bundles that import only the definitions from that entry no longer carry the fixture's private signing key.
