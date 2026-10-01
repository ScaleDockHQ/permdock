---
'permdock': patch
---

SCIM discovery follows RFC 7644 section 4: `/Schemas` and `/ResourceTypes` return ListResponses, serve one item by id, carry `meta`, and refuse a `filter` with 403. Every advertised attribute states `multiValued` and `required`. Created users and groups now get a real `meta.created` time instead of an empty string.
