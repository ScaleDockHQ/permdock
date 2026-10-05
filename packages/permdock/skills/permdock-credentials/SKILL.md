---
name: permdock-credentials
description: Resolves PermDock subjects from access tokens, API keys and share links. Use when verifying OAuth or OIDC access tokens with subjectFromJwt or an introspection response with subjectFromIntrospection, issuing personal access tokens, API keys or service accounts with decideCredential and resolving them with subjectFromApiKey, setting tenant key rules (maxTtl, kinds, allowNoExpiry) in a SettingsSource, minting guest or share links with signCapability and resolving them with subjectFromCapability, serving a link through RLS with exchangeCapability, or fixing doctor PD029 and on('auth') causes such as invalid-chain.
license: MIT
metadata:
  author: ScaleDockHQ
  homepage: https://permdock.com/docs/concepts/authentication
  repository: https://github.com/ScaleDockHQ/permdock
---

# PermDock credentials

Authentication is upstream: core never verifies a token. A `subjectFrom*` resolver verifies the material and hands core a `Subject`, and anything it cannot verify becomes the anonymous subject, never a throw ([authentication](https://permdock.com/docs/concepts/authentication)). Set up the policy and factory first with the `permdock-wire` skill (`npx skills add ScaleDockHQ/PermDock --skill permdock-wire`).

## Inputs (find out, or ask before starting)

- Which credentials reach the app: browser sessions, OAuth or OIDC access tokens, introspected tokens, API keys, CI job tokens, share links.
- For tokens: the issuer, the resource identifier (audience) and the signing algorithms.
- For keys: personal (`user`) keys, service accounts (`service`), or both; where the hashes are stored; the tenant rules on lifetime and kinds.
- For links: what a link opens, who may redeem it, how long it lives, and whether Postgres RLS must serve the guest page.

## Invariants

1. Core never verifies a token or a session. Only `permdock/jwt`, `permdock/server` key helpers and the provider `subjectFrom*` helpers do.
2. A resolver never throws. An unverifiable token, key or link is the anonymous subject, and the cause goes to `on('auth')`.
3. Never build grants from user-editable claims (`user_metadata`), and never take a subject from a request body, an unsigned header, a CLI flag or a model argument.
4. Store only `hashApiKey(key)` and show the key once. Every key lists its permissions and expires unless the tenant opts in with `allowNoExpiry`.
5. A share link is a signed, expiring capability on one resource. It never holds a scope or global role, and RLS sees it only through `exchangeCapability`, never `service_role`.
6. Token rules come from the spec skills (`npx skills add ScaleDockHQ/scaledock-skills --skill <name>`): `jwt` for JOSE, `oauth` for access tokens and introspection, `openid-connect` for ID tokens and Discovery.

## Workflow

1. **Verify access tokens.** Resolve the subject with `subjectFromJwt(token, { discovery, audience })` from `permdock/jwt`, or `subjectFromIntrospection` when the app already called introspection. -> [references/tokens-keys-links.md](references/tokens-keys-links.md)
   ✓ An ID token, a token for another audience and an expired token each resolve to the anonymous subject.
2. **Issue API keys, when the product has them.** Guard the creation endpoint with its own permission, call `decideCredential(permdock, request, { settings })`, store the hash with the returned `Credential`, and show the key once. -> [references/tokens-keys-links.md](references/tokens-keys-links.md#api-keys-and-service-accounts)
   ✓ A service key wider than its creator is denied with `exceeds-creator`.
3. **Resolve API keys.** Build `subjectFromApiKey({ verifier: apiKeyVerifier({ find }), permissions, owner, revoked, settings, sink })` and call it as `resolveKey(key, { tenant })`.
   ✓ A revoked or expired key is anonymous, and a user key never exceeds its owner's current rights.
4. **Share links, when the product has them.** Declare the link's roles on the resource, mint with `signCapability` behind a guard of its own, and resolve with `subjectFromCapability` and the tenant's `linkPolicy`. With Supabase RLS, exchange the link with `exchangeCapability` and generate with `--capabilities`. -> [references/tokens-keys-links.md](references/tokens-keys-links.md#share-links)
   ✓ An expired, revoked or replayed (`once`) link resolves to the anonymous subject.
5. **Test.** Add scenario tests for each credential kind: a valid one, a forged or expired one, and a key or link used past its permissions ([scenario testing](https://permdock.com/docs/guides/scenario-testing)). Run `permdock doctor`.
   ✓ The tests pass and PD029 is clean.

## Verify before done

- [ ] `subjectFromJwt` uses Discovery or an explicit `jwks` plus `issuer`, sets `audience`, and allows only `Ed25519`, `ES256` or `PS256`.
- [ ] No subject, tenant or membership comes from `user_metadata`, a request body or an unsigned header.
- [ ] API keys are stored as hashes, created only through `decideCredential` behind their own guard, and expire (PD029).
- [ ] No `memberships` source is passed to `createPermDock` for service-key subjects.
- [ ] Share links expire, are minted behind their own guard, and reach RLS only through `exchangeCapability`.

## Reference index

- [references/tokens-keys-links.md](references/tokens-keys-links.md): `subjectFromJwt` options, introspection, CI OIDC, `decideCredential`, key storage and resolution, tenant settings, `signCapability`, `subjectFromCapability`, `exchangeCapability`.
- Docs: [authentication](https://permdock.com/docs/concepts/authentication), [subject](https://permdock.com/docs/concepts/subject), [JWT adapter](https://permdock.com/docs/adapters/jwt), [API keys](https://permdock.com/docs/concepts/credentials), [link capabilities](https://permdock.com/docs/concepts/capabilities), [JOSE](https://permdock.com/docs/standards/jose).
