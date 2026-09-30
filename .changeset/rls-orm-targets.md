---
'permdock': minor
---

`permdock rls generate --target drizzle` writes `pgPolicy(...).link(schema.<table>)` exports with the `drizzle-orm/supabase` roles, and `--target prisma` writes Prisma 8 `policy_*` blocks and refuses deny grants, which Prisma 8 cannot express. Both targets also write `<out>.migration.sql` with the helpers, grants and `enable row level security`, and `--check` compares both files. `rls.drizzle.schema`, `rls.drizzle.exports` and `rls.prisma.models` set import paths and names.
