# 0011. The docs app has no `robots.ts`

- Status: accepted
- Date: 2026-09-30

## Context

The standard gives each Next.js app a `sitemap.ts` and a `robots.ts`. Marketing and docs are two Vercel Services on one origin, and a crawler reads `/robots.txt` only at the origin root, which marketing owns.

## Decision

Marketing's `robots.ts` lists both `/sitemap.xml` and `/docs/sitemap.xml`. The docs app serves `/docs/sitemap.xml` and no `robots.txt`.

## Consequences

A crawl rule for docs pages is edited in `apps/marketing/app/robots.ts`.

## Alternatives considered

- A `robots.ts` in each app: the docs one would be served at `/docs/robots.txt`, which crawlers never read.
