# PowerSync (offline reads and writes)

```ts title="src/lib/powersync/database.ts"
import { powersyncExecutor } from "better-supabase/powersync";

export const local = betterSupabase.connect(powersyncExecutor(powersync));
```

- `local.customers.findMany(...)` and `list.run(local, query)` run on the device's SQLite database and return the same rows (casing, Temporal values) as PostgREST.
- Live results: `watch(powersync, () => list.run(local, query), { tables: sqliteTables(betterSupabase, ["customers"]), onResult })`.
- Includes, related counts, full-text search, `db.$rpc` and writes to tables without a primary key return a `DbError` of kind `unsupported`. Assert `checkSqlite(betterSupabase, list, { all: true })` is `[]` in a test for every list a native screen runs.
- `powersyncExecutor(powersync, { fallback: postgrestExecutor(supabase, betterSupabase.executorOptions()) })` sends unsupported reads and `$rpc` to PostgREST (online only); writes never fall back. In `watch`, a fallback read reruns on local changes to `tables`, not on server changes; pass `refresh: { everyMs: 30_000, onReconnect: true }` to `watch` or `useWatch` so it reruns on an interval (skipped offline) and on reconnect. Prefer syncing a summary table through sync rules when the screen must work offline.
- `ilike` is SQLite `like` (case-insensitive for ASCII only).

## Uploading local writes

In the connector's `uploadData`, replay each `CrudEntry` through the online
client's repositories (`bs.db` from `better-supabase/client/native`), so RLS
and validation run:

| `entry.op` | Call                                        |
| ---------- | ------------------------------------------- |
| `PUT`      | `upsert({ ...entry.opData, id: entry.id })` |
| `PATCH`    | `update(entry.id, entry.opData)`            |
| `DELETE`   | `delete(entry.id)`                          |

Decide by `error.kind`, with an exhaustive `switch` ending in a `never` check:

- Retry (throw, PowerSync calls again): `network`, `timeout`, `aborted`, `rate_limited`, `serialization`, `unauthorized`, `unexpected`.
- Conflict (complete, then show it on the row): `conflict`, `stale`, `foreign_key`.
- Discard (complete): every other kind; the server will never accept it.

Never throw for a kind that can't succeed: it blocks the upload queue.

Docs: https://bettersupabase.com/docs/repository/powersync.md and
https://bettersupabase.com/docs/guides/offline-first.md.
