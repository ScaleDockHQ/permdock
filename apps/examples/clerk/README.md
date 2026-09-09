# `@permdock/example-clerk`

Hono wiring for `permdock/clerk`: `subjectFromClerk` on `PATCH /posts/:id` (granted for `org:member` on their own post) and `POST /posts/:id/delete` (denied). `pnpm start` listens on `127.0.0.1:3464`.

```ts
import { subjectFromClerk } from 'permdock/clerk'
```
