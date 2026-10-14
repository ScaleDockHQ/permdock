---
"permdock": minor
---

New `permdock/h3`, `permdock/sveltekit`, `permdock/astro`, `permdock/solid-start` and `permdock/tanstack-start` entries. Each `createPermDock` returns `middleware()`, `protect(permission | operation, data)`, `getPermDock`, `getSnapshot`, `connection` and `permdockHandler()`; the h3, SvelteKit, Astro and SolidStart adapters add `withPermDock(handler)`. A refusal or a thrown PermDock error is RFC 9457 Problem Details. h3, `@sveltejs/kit`, `astro`, `@solidjs/start` and `@tanstack/react-start` are optional peers.
