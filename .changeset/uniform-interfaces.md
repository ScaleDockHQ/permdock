---
"permdock": minor
---

Extension interfaces share one shape. Every interface takes an optional `name`, which `on('auth')` reports when that source throws (`{ reason: 'source-threw', source: 'memberships', name }`). Every `DirectoryStore` method may now answer with a value or a Promise, like the other interfaces.

`webBotAuthVerifier(options)` returns an object, like every other verifier:

| Before                                                | After                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `webBotAuthVerifier(options)(request)`                | `webBotAuthVerifier(options).verify(request)`                  |
| a hand-written `webBotAuth: async (request) => actor` | `webBotAuth: { verify: async (request) => actor }`             |
| `DirectoryStore` methods returned `Promise<T>`        | `T \| Promise<T>`; a caller that chains `.then` awaits instead |
