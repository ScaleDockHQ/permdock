# PowerSync (offline reads and writes)

```ts title="src/lib/supabase/client.native.ts"
import { createNativeClient } from "better-supabase/client/native";
import { powersyncEngine } from "better-supabase/powersync";

export const bsb = createNativeClient(betterSupabase, supabase, {
  engine: powersyncEngine(powersync, { connector, local: ["customers"] }),
});
```

- `bsb.db.customers.list(...)`, `list.run(bsb.db, query)` and the generated hooks (`useCustomers(...)`) run on the device's SQLite database and return the same rows (casing, Temporal values) as PostgREST. Tables missing from `local` run on PostgREST; leave `local` out when every table syncs.
- Hooks read again when PowerSync reports a change to their table. A hook named after something else (`defineDataHooks("customer-pages", ...)`) names its tables: `tables: { "customer-pages": ["customers"] }`.
- `useSyncStatus()` and `useConflicts()` from `better-supabase/react` read the engine's sync state and the connector's rejected changes.
- Includes (nested, filtered, ordered, limited, `required`), related counts and related aggregates run on SQLite as one statement, so sync the included tables too. Full-text search, function sources and writes to tables without a primary key compile to `unsupported`. Assert `checkSqlite(betterSupabase, list, { all: true })` is `[]` in a test for every list a native screen runs, and pass a `betterSupabase.spec.<table>.<method>(...)` spec to check a single read.
- Unsupported reads and `db.$rpc` fall back to PostgREST (online only); writes never fall back. Every hook reads again when PowerSync reconnects. Pass `fallback: false` to keep every call on the device. Prefer syncing a summary table through sync rules when the screen must work offline.
- To run the repositories without the client: `betterSupabase.connect(powersyncExecutor(powersync))`.
- `ilike` is SQLite `like` (case-insensitive for ASCII only).

## Uploading local writes

In the connector's `uploadData`, replay each `CrudEntry` through repositories
on PostgREST, so RLS and validation run. `bsb.db` runs on the device with the
engine, so build a second client without it:
`const server = bindClient(betterSupabase, supabase)` from
`better-supabase/client`, in its own module to avoid an import cycle.

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

`createUploadConnector({ endpoint, supabase, tables })` from
`better-supabase/powersync` does this replay and the outcome mapping for you:

- `tables: { customers: server.db.customers }` takes a repository; every generated repository fits `UploadRepository<Insert, Key>` without a cast.
- `uploadRoute(server.db.attachments, { put: "create" })` for write-once tables: a `PUT` calls `create` and a `conflict` counts as applied (the row is already on the server); a `PATCH` is discarded as `unsupported`.
- `onError: (error, { phase }) => ...` logs a failed `getSession` (`phase: "credentials"`, kind `unauthorized` or `network`; `fetchCredentials` returns `null`) and uploads that stay queued for a retry (`phase: "upload"`).

## Offline blocks

`gen.powersync.instances` syncs `notifications`, `attachments`, `memberships`,
`teams` and `profiles`. Give each block client a local transport with
`server: rpcTransport(supabase)`, and route its tables through a server client:

| Block         | Transport                         | Upload routes                                                                    |
| ------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| notifications | `powersyncNotificationsTransport` | `notification_recipients: notificationRecipientsRoute(remote)`                   |
| organizations | `powersyncMembershipsTransport`   | `memberships: membershipsRoute(remote)`                                          |
| teams         | `powersyncTeamsTransport`         | `teams: teamsRoute(remote, powersync)`, `team_members: teamMembersRoute(remote)` |
| profiles      | `powersyncProfilesTransport`      | `profiles: profilesRoute(remote)`                                                |

The synced rows are the user's own (memberships, their teams, their profile).
Switching organizations and creating or deleting a team need the network.

Docs: https://bettersupabase.com/docs/frontend/powersync.md and
https://bettersupabase.com/docs/guides/offline-first.md.
