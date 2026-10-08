# `@permdock/example-clerk`

Hono wiring for `permdock/clerk`: `createClerkSubjectResolver` with `memberships: 'all'` and a 10-second membership cache is the `subject` of `createPermDock` from `permdock/hono`. `protect` guards `PATCH /posts/:id` (granted for `org:member` on their own post) and `POST /posts/:id/delete` (denied with Problem Details). `pnpm start` listens on `127.0.0.1:3464`.

```ts
import { createClerkSubjectResolver } from "permdock/clerk";
```
