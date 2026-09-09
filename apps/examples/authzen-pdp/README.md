# `@permdock/example-authzen-pdp`

`node:http` wrapper around the AuthZEN Fetch `handler`. `pnpm start` listens on `127.0.0.1:3470`.

- `GET /health`
- `POST /access/v1/evaluation` with `Authorization: Bearer test` — grants `post.update`, denies `post.publish`

```ts
import { createPermDock } from 'permdock/authzen'
```
