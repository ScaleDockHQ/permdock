---
"permdock": patch
---

`permdock openapi annotate` takes the JSDoc block directly above each handler, so a file header `@permission` no longer lands on the first handler. It also reads `export const GET` and `export { handler as GET }`, maps `app/route.ts` to `/` and an optional catch-all `[[...slug]]` to `{slug}`.
