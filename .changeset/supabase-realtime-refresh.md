---
"permdock": minor
---

`supabaseRealtimeRefresh(client, { userId, channel, foreground })` takes an app-owned `channel`, which it binds without subscribing or removing, and a `foreground` subscription: in the background it leaves its own channel, and on return it rejoins and calls `refresh()` once.
