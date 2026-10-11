# Vue, Solid, Svelte, TanStack DB and expo-sqlite

Each framework binding wraps the browser client `bs` from
`lib/supabase/client.ts` and the TanStack Query client for that framework.
Reads still go through PostgREST as the signed-in user, so RLS applies.

## Vue

```ts title="src/main.ts"
import { betterSupabase } from "better-supabase/vue";

createApp(App)
  .use(VueQueryPlugin, { queryClient })
  .use(betterSupabase(bs, { queryClient }))
  .mount("#app");
```

```ts title="src/lib/composables.ts"
import { createBindings } from "better-supabase/vue";
import type { bs } from "./supabase/client";

export const { useDb, useQueries, useAuth, useSession } =
  createBindings<typeof bs>();
```

Use `useQuery(q.customers.findMany({ ... }))` from `@tanstack/vue-query`
with `const q = useQueries()`. `useLiveQuery`, `useLiveCount`,
`useBroadcast`, `usePresence` and `useAction` come from
`better-supabase/vue` directly.

## Solid

Wrap the app in `<BetterSupabaseProvider client={bs} queryClient={queryClient}>`
inside `QueryClientProvider`, and get typed primitives from
`createBindings<typeof bs>()` in `better-supabase/solid`. Pass a function to
the live primitives, so they track their inputs:
`useLiveCount(() => betterSupabase.spec.messages.count({ where: { read: false } }))`.

## Svelte 5

In the root `+layout.svelte`, call `setBetterSupabase(bs, { queryClient })`
and `setSession(() => data.session)` from `better-supabase/svelte`. In
components, `useAuth()`, `useLiveQuery(() => spec)` and `useLiveCount(() => spec)`
return objects whose fields are reactive (`auth.current.status`,
`unread.count`). Return `null` from the spec function to pause a query.

## TanStack DB

```ts
import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { collectionOptions } from "better-supabase/tanstack-db";

export const customers = createCollection(
  queryCollectionOptions(
    collectionOptions(betterSupabase, db, "customers", {
      query: queries.customers.findMany({ where: { status: "active" } }),
      queryClient,
    }),
  ),
);
```

The collection loads through the query and writes through the
repositories, so its inserts and updates run as the signed-in user.

## expo-sqlite

Run the same repositories over a local database on the device, without
PowerSync:

```ts
import { addDatabaseChangeListener, openDatabaseAsync } from "expo-sqlite";
import {
  expoSqliteDatabase,
  expoSqliteExecutor,
} from "better-supabase/expo-sqlite";

const sqlite = await openDatabaseAsync("app.db", {
  enableChangeListener: true,
});
export const local = betterSupabase.connect(
  expoSqliteExecutor(sqlite, { addDatabaseChangeListener }),
);
export const database = expoSqliteDatabase(sqlite, {
  addDatabaseChangeListener,
});
```

Keep a list live with `useWatch({ db: database, tables: ["notes"], query: () => local.notes.findMany(...) })`
from `better-supabase/powersync/react`. The local database has no RLS: it
holds only what this device's user synced or wrote.

Docs: https://bettersupabase.com/docs/frontend/vue.md (and `solid`,
`svelte`, `tanstack-db` under `/docs/frontend/`) and
https://bettersupabase.com/docs/repository/expo-sqlite.md.
