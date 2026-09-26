---
'permdock': patch
---

`permdock/solid`: `PermDockProvider` forwards a snapshot accessor to the store in a computation instead of an effect. Under SolidStart streaming SSR, an effect below a still-suspended `<Suspense>` could be deferred past hydration and leave the store `pending`, so every `usePermission` answered `denied` while the server-rendered page showed the grants.
