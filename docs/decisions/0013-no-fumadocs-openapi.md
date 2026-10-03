# 0013. No `fumadocs-openapi` pages

- Status: accepted
- Date: 2026-09-30

## Context

The standard renders an API reference with `fumadocs-openapi`. PermDock has no HTTP API of its own. `packages/permdock/schemas/openapi` holds only the OpenAPI 3.1 and 3.2 and Overlay meta-schemas, which `permdock openapi` validates against. It does not hold a PermDock API document.

## Decision

The docs app does not depend on `fumadocs-openapi`. The CLI and adapter pages document the OpenAPI output.

## Consequences

Revisit when PermDock Cloud publishes an API document for these docs.

## Alternatives considered

- A reference page built from the vendored meta-schemas: they describe OpenAPI itself, not an API PermDock serves.
