# 0012. Cross-zone links are plain anchors

- Status: accepted
- Date: 2026-09-30

## Context

The standard uses `next/link` for internal links. A `next/link` from marketing to `/docs` makes a client-side navigation inside the marketing app, which has no `/docs` route, so it renders the marketing 404 until a reload.

## Decision

Links that cross between marketing and docs render a plain `<a>` through `SiteLink`. Links inside one app use `next/link`.

## Consequences

Cross-zone navigation is a full page load, with no prefetch.
