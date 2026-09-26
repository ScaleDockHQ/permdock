---
'permdock': patch
---

`parseSnapshot`, and every client store built on it, now freezes a plain copy of an unfrozen snapshot object and leaves the caller's object untouched. Freezing it in place broke framework proxies around the snapshot: server rendering with a snapshot in Nuxt `useState` or Vue `reactive` failed with a proxy invariant error.
