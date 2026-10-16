# 0030. `Vary: Accept` only on the Markdown response

- Status: accepted
- Date: 2026-10-16

## Context

The standard negotiates Markdown with `beforeFiles` rewrites on the `Accept` header and adds a `headers()` rule that sends `Vary: Accept` on the negotiated pages. Next.js drops `Vary` from page responses, so a `headers()` rule never reaches the HTML twin.

## Decision

`apps/docs/app/llms.mdx/docs/[[...slug]]/route.ts` sends `Vary: Accept` on the Markdown response. `apps/docs/next.config.ts` has no `headers()` rule for it.

## Consequences

A shared cache that stores the HTML response first does not learn that the URL varies. Vercel's CDN keys the rewrite on the `has` condition, so it serves each representation correctly. Revisit when Next.js keeps `Vary` on page responses.

## Alternatives considered

- A `headers()` rule: Next.js removes the header, so it has no effect.
