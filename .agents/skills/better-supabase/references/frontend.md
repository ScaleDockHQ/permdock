# Vue, Solid, Svelte, TanStack DB and SQLite

Each framework binding wraps the browser client `bsb` from
`lib/supabase/client.ts` and the TanStack Query client for that framework.
Reads still go through PostgREST as the signed-in user, so RLS applies.

## Vue

```ts title="src/main.ts"
import { betterSupabase } from "better-supabase/vue";

createApp(App)
  .use(VueQueryPlugin, { queryClient })
  .use(betterSupabase(bsb, { queryClient }))
  .mount("#app");
```

```ts title="src/lib/composables.ts"
import { createBindings } from "better-supabase/vue";

import type { bsb } from "./supabase/client";

export const { useDb, useQueries, useAuth, useSession } =
  createBindings<typeof bsb>();
```

Use `useQuery(q.customers.list({ ... }))` from `@tanstack/vue-query`
with `const q = useQueries()`. `useLiveQuery`, `useLiveCount`,
`useBroadcast`, `usePresence` and `useAction` come from
`better-supabase/vue` directly.

## Solid

Wrap the app in `<BetterSupabaseProvider client={bsb} queryClient={queryClient}>`
inside `QueryClientProvider`, and get typed primitives from
`createBindings<typeof bsb>()` in `better-supabase/solid`. Pass a function to
the live primitives, so they track their inputs:
`useLiveCount(() => betterSupabase.spec.messages.count({ where: { read: false } }))`.

## Svelte 5

In the root `+layout.svelte`, call `setBetterSupabase(bsb, { queryClient })`
and `setSession(() => data.session)` from `better-supabase/svelte`. In
components, `useAuth()`, `useLiveQuery(() => spec)` and `useLiveCount(() => spec)`
return objects whose fields are reactive (`auth.current.status`,
`unread.count`). Return `null` from the spec function to pause a query.

## TanStack DB

```ts
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { collectionOptions } from "better-supabase/tanstack-db";

export const customers = createCollection(
  queryCollectionOptions(
    collectionOptions(betterSupabase, db, "customers", {
      query: queries.customers.list({ where: { status: "active" } }),
      queryClient,
    }),
  ),
);
```

The collection loads through the query and writes through the
repositories, so its inserts and updates run as the signed-in user.

## SQLite on the device

Run the data hooks and `bsb.db` on a local database, without PowerSync:

```ts
import { createNativeClient } from "better-supabase/client/native";
import { expoSqliteDatabase, sqliteEngine } from "better-supabase/sqlite";
import { addDatabaseChangeListener, openDatabaseAsync } from "expo-sqlite";

const sqlite = await openDatabaseAsync("app.db", {
  enableChangeListener: true,
});
export const bsb = createNativeClient(betterSupabase, supabase, {
  engine: sqliteEngine(
    expoSqliteDatabase(sqlite, { addDatabaseChangeListener }),
    { local: ["notes"] },
  ),
});
```

`local` lists the tables the device database holds; the rest run on
PostgREST. The generated hooks (`useNotes(...)`) read the local table and
read again when it changes. `liteDatabase(connection)` does the same for a
Supabase Lite connection. The local database has no RLS: it holds only what
this device's user synced or wrote.

`tanstackDbEngine({ collections: () => ({ customers }) })` from
`better-supabase/tanstack-db` keeps the hooks in step with TanStack DB
collections.

Docs: https://bettersupabase.com/docs/frontend/vue.md (and `solid`,
`svelte`, `tanstack-db` under `/docs/frontend/`) and
https://bettersupabase.com/docs/frontend/sqlite.md.
