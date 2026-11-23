---
"permdock": minor
---

The server kernel and every adapter built on it take `waitUntil` (from `@vercel/functions` or `cloudflare:workers`), which keeps the function alive for each pending `sink` write and one `flush()` per tick, as `permdock/next` already does with `after()`.
