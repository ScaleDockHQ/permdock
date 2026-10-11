# Expo and React Native

## Server (web): `better-supabase/expo`

Needs `expo-server` 55 or later and, in `app.json`, `web.output: "server"`.
On Expo SDK 57 and earlier, also set the `expo-router` plugin options
`unstable_useServerDataLoaders`, `unstable_useServerMiddleware` and
`unstable_useServerRendering`. SDK 58 needs no opt-in; the three options are
deprecated there and have no effect.

```ts title="src/lib/supabase/server.ts"
import { createExpo } from "better-supabase/expo";
import { betterSupabase } from "./index";

export const bs = createExpo(betterSupabase);
```

```tsx title="src/app/customers/index.tsx"
export const loader = bs.loader(
  ({ db }) => db.customers.findMany({ select: ["id", "name"] }).orThrow(),
  { allow: ["user"] },
);
```

```ts title="src/app/+middleware.ts"
export default bs.middleware();
```

- Loaders run as the caller (bearer token first, then the cookie), so RLS applies.
- A refused caller and a `DbException` from `.orThrow()` become a `StatusError` with the right status.
- Only `+middleware.ts` refreshes the session; loaders never do.
- `bs.loader` returns an `expo-server` `LoaderFunction`. Inside an existing `createServerLoader(async (request, params) => ...)`, call `const { db } = await bs.request(request, { allow })`. Static rendering has no request: use `createStaticLoader` from `expo-server` for public data there.
- Loader data is JSON: select the columns the screen needs and turn Temporal values into strings.
- API routes: `export const GET = bs.handler((request, { db }) => db.customers.findMany())` in `+api.ts`.

## Device: `better-supabase/client/native`

```ts title="src/lib/supabase/native.ts"
import { createClient } from "@supabase/supabase-js";
import {
  autoRefreshOnForeground,
  createNativeClient,
  secureStorage,
} from "better-supabase/client/native";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";

const supabase = createClient(url, key, {
  auth: {
    storage: secureStorage(SecureStore),
    persistSession: true,
    detectSessionInUrl: false,
  },
});
autoRefreshOnForeground(supabase, AppState);
export const bs = createNativeClient(betterSupabase, supabase);
```

- `autoRefreshOnForeground(supabase, AppState)` refreshes the session only while the app is active; supabase-js can't detect the background on React Native.
- Never import `better-supabase/client` on the device: it pulls in `@supabase/ssr`.
- Hermes has no `Temporal`: `defineSupabase(schema, { temporal: Temporal })` with `temporal-polyfill`, no global install.
- Put device-only code (SecureStore, PowerSync) in `.native.ts` files or modules only they import.

Done when the web export has no `expo-secure-store` or PowerSync code, a loader
answers 401 for a signed-out request, and a native screen reads with `bs.db`.

Docs: https://bettersupabase.com/docs/frameworks/expo.md and
https://bettersupabase.com/docs/frontend/react-native.md.
