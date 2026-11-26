import "server-only";
import { createNext } from "better-supabase/next";

import { env } from "../../env.ts";
import { audience, betterSupabase, cookieName } from "./index.ts";
import { issuer, postgres, versions } from "./runtime.ts";
import { authorization, sharedCache } from "./shared-cache.ts";

export { freshMemberships, issuer, postgres, versions } from "./runtime.ts";
export { authorization } from "./shared-cache.ts";

export const bsb = createNext(betterSupabase, {
  env: {
    url: env.supabaseUrl,
    publishableKey: env.publishableKey,
    jwksUrl: new URL(`${issuer}/.well-known/jwks.json`),
  },
  postgres,
  versions,
  authorizer: authorization,
  auth: {
    ...(env.verificationKeys && { jwks: env.verificationKeys }),
    issuer,
    audience,
    cookie: { name: cookieName },
  },
  // Counts stay off unless this process was built to be measured.
  ...(env.measure ? { debug: { enabled: true, coldStart: true } } : {}),
  ...sharedCache,
});
