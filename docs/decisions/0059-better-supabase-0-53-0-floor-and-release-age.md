# 0059. better-supabase 0.53.0 is the peer floor and the catalog pin, and skips the one-day release age

- Status: accepted
- Date: 2026-11-04
- Supersedes: the floor, catalog pin, exclude and CI matrix of 0054

## Context

better-supabase 0.53.0 reached npm at 20:15 UTC on 2026-11-04. The [upstream changelog](https://github.com/ScaleDockHQ/better-supabase/blob/main/packages/better-supabase/CHANGELOG.md) was reviewed for 0.40 through 0.53. Peers, subpaths and the Node engine are unchanged except for new optional peers. The releases PermDock builds on:

- 0.47 gives the block clients one object argument per call: `approvals.request`, `approve`, `reject` and `consume`, and share links `resolve({ token })`.
- 0.52 adds `createVersionCache`, a typed `AuthorizerRuntime.seed` and `AuthzSubjectSeed`.
- 0.53 adds `AuthorizationFunctions.subject`, a required `Bootstrap.endReason`, approval policy steps that read back as `{ required: 0, all: true }`, and `approval_eligible_ids`.

On 0.39 the bridges in `permdock/better-supabase` call the old positional signatures, so every approval request and share link fails on 0.47 or later.

## Decision

- The peer floor is `>=0.53.0`, the catalog pins 0.53.0 and `better-supabase-floor` aliases 0.53.0. `ci.yml` runs the provider and its integration tests on the one entry `0.53.0`.
- `minimumReleaseAgeExclude` lists `better-supabase@0.53.0`, that version only. `minimumReleaseAge` stays at 1440.
- `blockApprovalStore`, `blockApprovalPolicySource` and `subjectFromShareLink` use the object inputs only. A policy step with `escalateAfter` throws, since PermDock has no escalation.

## Consequences

Remove the exclude from 20:16 UTC on 2026-11-05. Adopters on better-supabase 0.52 or older must upgrade before installing the next permdock release. A password-protected share link stays anonymous: `resolve` fails without a password and PermDock passes none.

## Alternatives considered

- Support the 0.39 and 0.47 call shapes together: each bridge would carry a runtime shape check for a release CI no longer tests.
- Keep the 0.39 floor and test 0.53 in a matrix: the typed `seed` and the object inputs cannot be expressed against both.
