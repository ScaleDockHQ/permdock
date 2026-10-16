# 0033. `next.json` sets `jsx: "react-jsx"`

- Status: accepted
- Date: 2026-10-16

## Context

The standard's `next.json` sets `jsx: "preserve"`. Next.js 16.4.1 lists `jsx: "react-jsx"` as a required option ("next.js uses the React automatic runtime", `next/dist/lib/typescript/writeConfigurationDefaults.js`) and rewrites `preserve` in each app's `tsconfig.json` on `next dev` and `next build`.

## Decision

`packages/typescript-config/next.json` sets `jsx: "react-jsx"`, so `next build` leaves the app tsconfigs unchanged.

## Consequences

The value matches what Next.js writes; SWC compiles the JSX either way. Revisit if Next.js stops requiring `react-jsx`.

## Alternatives considered

- `jsx: "preserve"`: every build rewrites the app tsconfigs and leaves an uncommitted change.
