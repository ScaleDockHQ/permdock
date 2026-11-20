# Native and Expo

## Refresh the token when roles change

With `blocks.sessions.options.authzVersions`, the database bumps a user's
version when their memberships, roles or grants change, writes it to the
token as `authz_ver` and broadcasts it on the private topic `authz:<uid>`.

```tsx
// src/app/_layout.native.tsx
import { SessionProvider } from "better-supabase/react/native";
import { AppState } from "react-native";

export default function RootLayout() {
  return (
    <AppShell>
      <SessionProvider appState={AppState} powersync={sync}>
        <Stack />
      </SessionProvider>
    </AppShell>
  );
}
```

- `AppShell` renders `<BetterSupabaseProvider client={bsb}>`; the provider
  reads its supabase-js client, or takes `client`.
- It subscribes only while `AppState` is `active`. Each join reads the live
  version, so a change made in the background applies when the app returns.
- It refreshes only when the live version is ahead of the token's; an equal
  version makes no Auth call.
- `onAuthzChange` runs after the refresh: invalidate the screen's queries
  there.
- `topic`, `event` and `source` are for a library that broadcasts on its own
  channel. Pass a stable `topic` function.
- Outside React: `startNativeAuthzRefresh({ client, userId, appState,
  powersync })` from `better-supabase/client/native` returns the cleanup.

Use the browser `SessionProvider` from `better-supabase/react` only on the
web; it follows tab visibility and `BroadcastChannel`, which React Native
doesn't have.

## PowerSync

```ts
// src/lib/powersync/sync.ts
export const sync: AuthSync = syncWithAuth(powersync, bsb.auth, { connector });

export async function afterSwitch(result: SwitchResult): Promise<void> {
  if (result.refresh) {
    const { error } = await supabase.auth.refreshSession();
    if (error) throw error;
  }
  await sync.reconnect();
}
```

- The sync service reads claims only on connect, so a refreshed token needs a
  reconnect before the device drops rows the user lost. `syncWithAuth` does
  it when the user, tenant or `authz_ver` fingerprint changes.
- `sync.reconnect()` forces one. Concurrent calls share one reconnect, and a
  sign-out skips it.
- `fetchCredentials` must read the current session each call
  (`createUploadConnector` does). A cached token reconnects with old claims.
- Pass `tenantClaim` when `config.claims.tenant` is renamed, or `fingerprint`
  for other claims.
- Create one `sync` for the app at module scope, not one per screen.
- `better-supabase powersync streams` (or `gen` with `gen.powersync`) writes
  streams for blocks over the app's own tables too; it reads their columns
  from the saved snapshot.

## Expo web loaders

```ts
export const loader = bsb.loader(
  async (_ctx, params, request) => {
    const boot = await bsb.bootstrap<Counts>(request, {
      rpc: "islands",
      tenant: String(params.org),
    });
    const access = await bsb.getAccess(request, { bootstrap: boot });
    return {
      counts: boot.data,
      stale: boot.stale,
      canWrite: await access.can("customers.write"),
    };
  },
  { allow: ["user"] },
);
```

- `rpc` names an entry in `blocks.sessions.options.bootstrap`.
- One navigation's layout and page loaders share the call for 10 seconds.
- `authzVersion` is live, `tokenAuthzVersion` the token's, `stale` when the
  first is ahead. `getAccess` with `bootstrap` checks against the live one.
- `bsb.cached(request, { tables, tags, tenant })` returns the context and the
  tags for an app-side cache. Purge it from a cache adapter
  (`betterSupabase.cache({ name, invalidate: (t) => purge(cacheTagsOf(t)) })`,
  `cacheTagsOf` from `better-supabase/server`).
- Expo has no `next/cache`; don't import it from Expo code.

## Local stack on devices

The default issuer check accepts `127.0.0.1`, `localhost`, `[::1]`,
`10.0.2.2` and `10.0.3.2` on the same scheme, port and path when the project
URL is local. Add a LAN address with
`createExpo(betterSupabase, { auth: { loopbackAliases: ["192.168.1.20"] } })`.
A public project URL accepts none of them.

## Don't

- Don't refresh the token on a timer to pick up role changes; use
  `authzVersions` and `SessionProvider`.
- Don't reconnect PowerSync by disconnecting and connecting by hand; call
  `sync.reconnect()`, which runs in order with sign-in and sign-out.
- Don't set `issuer: false` to make an emulator work; use `loopbackAliases`.
