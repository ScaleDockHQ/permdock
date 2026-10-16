# 0013. No `fumadocs-openapi` pages

- Status: accepted
- Date: 2026-09-30
- Revised: 2026-10-16

## Context

The standard renders an API reference with `fumadocs-openapi`. The package itself serves no HTTP API. `packages/permdock/schemas/openapi` holds the OpenAPI 3.1 and 3.2 and Overlay meta-schemas, which `permdock openapi` validates against.

PermDock Cloud's HTTP API now has a document: `packages/permdock/schemas/cloud-api-v1.json`, an OpenAPI 3.1 file generated from `CLOUD_API_DOCUMENT` in `src/testing/cloud-api/document.ts`. `testCloudApi` validates a Cloud's responses against it, and the Cloud repository implements it.

## Decision

The docs app does not depend on `fumadocs-openapi`. The route tables under "HTTP API" in `adapters/cloud.mdx` are the reference; `pnpm docs:drift` (`scripts/docs-drift-cloud-routes.ts`) fails when a table lists a method and path the document lacks, or the document has one the tables do not list. The CLI and adapter pages document the OpenAPI output of `permdock openapi`.

## Consequences

- A Cloud route change edits `CLOUD_API_DOCUMENT`, regenerates the JSON file and edits the `cloud.mdx` table in the same pull request.
- The tables carry the client mapping (which `cloud()` call uses a route) that a generated reference cannot.
- Revisit when the document grows request and response examples worth rendering.

## Alternatives considered

- A reference page built from the vendored meta-schemas: they describe OpenAPI itself, not an API PermDock serves.
- `fumadocs-openapi` over `cloud-api-v1.json`: a second rendering of the same routes next to the tables, with no client mapping.
