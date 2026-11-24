---
"permdock": minor
---

`supabase.hook.activeTenant: "request"` declares that the app resolves the active tenant per request: doctor PD078 stays silent, and `authorizationProvider` states `tokenHook.activeOrganizationFrom: "resolver"`, so better-supabase's BS409 needs no `blocks.permissions.activeTenant` entry.
