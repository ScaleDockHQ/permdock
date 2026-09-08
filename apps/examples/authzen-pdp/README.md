# `@permdock/example-authzen-pdp`

Minimal `permdock/authzen` wiring: one Fetch `handler` for evaluation, evaluations, search and `.well-known/authzen-configuration`. Mount it on Hono, Next.js or `node:http` at `/access/v1/*` and `/.well-known/authzen-configuration`.

```ts
import { createPermDock } from 'permdock/authzen'
```
