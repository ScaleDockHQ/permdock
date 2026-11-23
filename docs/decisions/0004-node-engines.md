# 0004. `permdock` keeps `engines.node: ">=26"`

- Status: accepted
- Date: 2026-09-30

## Context

The standard pins the repository to one Node.js version through `devEngines`. That applies to contributors. The published package describes what consumers may run.

## Decision

The root `devEngines` pins the toolchain. `packages/permdock` publishes `engines.node: ">=26"`, the oldest Node.js its runtime entries and CLI are tested on.

## Consequences

Consumers on Node.js 25 or later are not warned. CI runs Node.js 26, so a break on a newer major shows up only in the runtime tests or a user report.

## Alternatives considered

- `engines.node` equal to the `devEngines` pin: consumers on any other 24.x release would get an engine warning for no reason.
- No `engines` field: a consumer on Node.js 22 would install and fail at runtime.
