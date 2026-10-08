# `@permdock/example-better-auth`

Hono wiring for `permdock/better-auth`: `subjectFromBetterAuth` is the `subject` and `betterAuthRoleSource` the `customRoles` of `createPermDock` from `permdock/hono`. `protect` guards `PATCH /posts/:id` (granted for the seeded member) and `POST /posts/:id/delete` (denied with Problem Details). `pnpm start` listens on `127.0.0.1:3463`.

```ts
import {
  subjectFromBetterAuth,
  betterAuthRoleSource,
} from "permdock/better-auth";
```
