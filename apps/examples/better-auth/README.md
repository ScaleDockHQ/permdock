# `@permdock/example-better-auth`

Hono wiring for `permdock/better-auth`: `subjectFromBetterAuth` and `betterAuthRoleSource` on `PATCH /posts/:id` (granted for the seeded member) and `POST /posts/:id/delete` (denied). `pnpm start` listens on `127.0.0.1:3463`.

```ts
import {
  subjectFromBetterAuth,
  betterAuthRoleSource,
} from "permdock/better-auth";
```
