# Tokens, API keys and share links

Owning pages: [JWT adapter](https://permdock.com/docs/adapters/jwt), [authentication](https://permdock.com/docs/concepts/authentication), [API keys](https://permdock.com/docs/concepts/credentials), [link capabilities](https://permdock.com/docs/concepts/capabilities).

## Access tokens — `permdock/jwt`

```ts
import { subjectFromJwt } from "permdock/jwt";

const subject = await subjectFromJwt(token, {
  discovery: "https://issuer.example.com",
  audience: "https://api.example.com",
});
```

- Prefer `discovery: '<issuer>'` over a hand-copied `jwks` URL. Set `audience` to the resource identifier. Write algorithms as `Ed25519`, `ES256` or `PS256`; never `EdDSA`, `none` or `RSA1_5`.
- Keep the default `accept: 'access-token'`, so an ID token never authorises an API call.
- `jose` is an optional peer. A failure is the anonymous subject, never a throw; the cause is reported through `on('auth')`. A claimed `act` chain that does not nest is anonymous with cause `invalid-chain`.
- When the app already called RFC 7662 or RFC 9767 introspection, pass the response JSON to `subjectFromIntrospection`. `active` other than `true` is anonymous, and the HTTP call stays the app's.
- In CI, `subjectFromCiOidc(jwt, { provider: 'github', audience })` returns a `workload` principal, never a user.
- A Supabase OAuth server token is an `oauth-client` actor. `subjectFromSupabase` drops the OpenID Connect identity scopes (`openid`, `profile`, `email`, `address`, `phone`, `offline_access`) from its delegation, so a token with only those reaches nothing. Let a client act for users with a policy `delegations` entry whose `to` is `{ kind: 'oauth-client', client: '<name>' }`, and map the verified id to that name with `subjectFromSupabase(claims, { clients: { <name>: env.CLIENT_ID } })` (or a function for dynamically registered clients); a literal `{ kind, id }` also works but ties the policy to one environment, never by reading identity scopes as permissions ([Supabase provider](https://permdock.com/docs/adapters/supabase#oauth-server-tokens)).

## API keys and service accounts

```ts
import { decideCredential } from "permdock";
import { generateApiKey, hashApiKey } from "permdock/server";

const decision = await decideCredential(
  permdock,
  {
    kind: "service", // or 'user'
    id: "svc_01J8",
    tenant: "o_1",
    roles: ["developer"],
    permissions: [permissions.repo.read],
    expiresAt: Math.floor(Date.now() / 1000) + 30 * 86_400,
  },
  { settings },
);
if (decision.outcome === "granted") {
  const key = generateApiKey(decision.credential.id);
  await db.insert(apiKeys).values({
    id: decision.credential.id,
    hash: await hashApiKey(key),
    credential: decision.credential,
  });
  return key; // shown once
}
```

- Guard the endpoint that creates keys with its own permission (`apiKey.create`).
- Every key lists at least one permission, with no upper bound. A `user` key is its owner's live rights narrowed to the key, and with `tenant` to the owner's memberships inside that tenant and no global role (never put a tenant id in `ids`, which holds resource ids); a `service` key is a `kind: 'service'` principal whose tenant, roles and permissions must be within the creator's `assignableRoles` / `assignablePermissions` (otherwise `exceeds-creator`). A key cannot mint keys.
- Tenant rules come from a `SettingsSource` (`memorySettings({ o_1: { credentials: { maxTtl, kinds, approval, allowNoExpiry } } })`). A key without `expiresAt` needs `allowNoExpiry`. `approval: true` makes creation `approval-required`; after approval, call `decideCredential` again with `approved: token`.
- Store only `hashApiKey(key)`. The key is `pdk_<id>_<secret><checksum>`; `parseApiKey` rejects a bad checksum before any lookup.

Resolve keys on each request:

```ts
import { apiKeyVerifier, subjectFromApiKey } from "permdock/server";

const resolveKey = subjectFromApiKey({
  verifier: apiKeyVerifier({ find: (id) => findKeyRow(id) }), // returns { credential, hash }
  permissions,
  owner: (id) => loadOwner(id), // the live owner of a user key
  revoked: (id) => isRevoked(id),
  settings,
  sink,
});

const subject = await resolveKey(bearer, { tenant });
```

Never pass a `memberships` source to `createPermDock` for a service-key subject: its one membership comes from the credential. `memoryCredentials()` is an in-process store for tests.

When the backend then queries Postgres for the key, put the key's permission keys (and, for a service key, its tenant and roles) in an `api_key` claim and set `rls.apiKeys` in `permdock.config.ts`: the generated helpers cap every allow at the key's permissions and hold a key that names a tenant to that tenant, so RLS agrees with `can()`. The key itself never goes to the database.

## Share links

```ts
import { signCapability } from "permdock";
import { subjectFromCapability } from "permdock/jwt";

// Declare the link's roles on the resource
role("guest", [allow(permissions.quote.read, { where: { status: "sent" } })], {
  on: permissions.quote,
});

// Mint, behind a guard of its own (quote.share)
const token = await signCapability(
  {
    id: linkId,
    on: { resource: permissions.quote, id: quote.id },
    roles: ["guest"],
    expiresAt,
  },
  signer,
  { audience },
);

// Resolve
const subject = await subjectFromCapability(token, {
  jwks,
  issuer,
  audience,
  revoked,
  replay,
  viewer,
  linkPolicy,
});
```

- The result is a `kind: 'link'` principal with one `{ on, roles, via: 'link' }` membership. It never holds a scope or global role.
- `linkPolicy` returns the tenant's `LinkPolicy` (`maxLifetime`, `redeemers`, `once`). Passing the same policy to `signCapability` refuses to mint a link the resolver would refuse.
- Never an unguessable id without expiry, and never a security-definer RPC for the guest page.

With Supabase, let RLS serve the link through an exchange, never the link token itself:

```ts
import { exchangeCapability } from "permdock/supabase";

const accessToken = await exchangeCapability(subject, {
  key: signingJwk,
  alg: "ES256",
  kid: "permdock-links",
  ttl: 300,
});
```

`accessToken` is `role: 'anon'` with a `capability` claim and no `sub`, or `undefined` for anything but a live link. Generate the matching policies with `permdock rls generate --capabilities`.
