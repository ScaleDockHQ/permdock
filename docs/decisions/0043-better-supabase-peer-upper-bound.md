# 0043. The better-supabase peer range ends below the minor after the newest tested release

- Status: superseded by 0045
- Date: 2026-10-21
- Supersedes: the "no upper bound" part of 0040

## Context

Decision 0040 dropped the upper bound of the `better-supabase` peer range, so `>=0.11.0` claimed support for every later release, including ones CI had never run. The better-supabase cloud app reported it: a peer range is a promise that a version works, and nobody had tested 0.13 or later.

better-supabase 0.12.0 adds `acting_member()` and `tenant_path` to the audit module. `permdock/better-supabase` reads neither, and CI tests 0.12.0 next to the 0.11.0 floor (0041).

## Decision

The peer range is `>=0.11.0 <0.13.0`: the floor stays the first entry of the CI matrices, and the upper bound is the minor after the catalog pin. `tests/package/better-supabase-peer-range.test.ts` checks both, so bumping the catalog pin to a new minor fails until the bound moves with it.

## Consequences

Each better-supabase minor needs a PermDock release before adopters can install it without a peer warning. That release is where CI first runs the new minor.

## Alternatives considered

- Keep no upper bound (0040): adopters get no signal for a release that breaks `permdock/better-supabase`.
- Bound below the next major (`<1.0.0`): before 1.0 a better-supabase minor may break, so the bound would claim as much as no bound.
