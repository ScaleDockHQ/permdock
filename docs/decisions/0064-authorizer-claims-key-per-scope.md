# 0064. The better-supabase authorizer serialises a claims object once per request scope

- Status: accepted
- Date: 2026-11-08

## Context

`authorizer()` in `permdock/better-supabase` keys the instance it shares across checks as `permdock:authorizer:` plus `canonicalJson([claims, tenant, intent])`. Every check serialised the whole claims object, memberships included. At 150 memberships that is 0.09 ms of a 0.38 ms `evaluate`, and 9.3 ms of the 13.9 ms a batch of 100 checks took (`packages/permdock/tests/bench/surfaces-perf.json`).

The key is security-relevant: it decides which checks share one instance, and an instance holds the subject built from the claims. A key that ignored a field of the claims could hand one caller another caller's instance.

## Decision

- The key text does not change. It is still the canonical JSON of `[claims, tenant, intent]`, covering every claim.
- The canonical text of a claims object is kept per scope: the runtime `memo` better-supabase passes for one request, or one `evaluations` call. A later check in the same scope that passes the same object reads the kept text.
- Nothing is kept across scopes, and the cache is a `WeakMap` keyed by the scope object, so it ends with the request.
- A claims object is read as the verified token payload and is not mutated while a request scope is open. A mutation inside a scope does not change the key of that scope. A later request starts a new scope and reads the object as it is then; `tests/better-supabase/authorizer.test.ts` asserts both.

## Consequences

- A check after the first in a scope costs the key of `tenant` and `intent` only: 100 checks at 150 memberships ran in 6.4 ms instead of 12.7 ms.
- Code that mutates claims between two checks of one request gets the first check's key for the second. better-supabase does not.

## Alternatives considered

- Key on `sub`, `authz_ver` and `session_id`: two tokens of one user with the same version but a different `memberships` claim, such as a stale and a fresh token, would share an instance.
- A process-wide `WeakMap` from claims object to text: a claims object mutated between requests would keep a stale key.
- A faster `canonicalJson`: a rewrite with loops and no intermediate arrays measured 0.093 to 0.076 ms, which is not enough.
