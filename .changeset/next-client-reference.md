---
'permdock': patch
---

Fix `permdock/next` in Server Components. The server `PermDockProvider` imported the React provider from a shared chunk without a `"use client"` directive, so importing `permdock/next` under the `react-server` condition failed on `createContext`. The provider now comes from a dedicated `react/provider-client.js` entry that starts with `"use client"` and renders as a Flight client reference. `tests/bundle` renders it under `react-server` and asserts that no server entry reaches a client-only React API outside a `"use client"` boundary.
