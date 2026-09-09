# `@permdock/example-supabase-rls`

Hono wiring for `permdock/supabase`: `subjectFromSupabase` on `PATCH /posts/:id` (granted for the member's own post) and `POST /posts/:id/publish` (denied). `GET /rls/authorize` returns SQL that never mentions `service_role`. `pnpm start` listens on `127.0.0.1:3469`.

```ts
import { authorizeSql, subjectFromSupabase } from 'permdock/supabase'
```
