# `@permdock/example-supabase-middleware`

`permdock/supabase/middleware` in a `@supabase/middleware` pipeline: `withClaims` from `@supabase/server` verifies the bearer token against a JWKS and contributes `ctx.jwtClaims`; `withPermDock` builds the request-scoped instance from those claims with `subjectFromSupabase`. `PATCH /posts/:id` decides inside the handler with `ctx.permdock.can`; `POST /posts/:id/publish` is guarded with `withPermDock({ protect })` and short-circuits with Problem Details. `POST /api/permdock` mounts the AuthZEN evaluations handler. `GET /posts/review-queue` is behind `withFeatureFlag` from `@supabase/middleware/feature-flag`, which reads `ctx.permdock` through the guard in `src/flags.ts` and answers 404 to anyone without `post.review`. `GET /flags` runs `withOpenFeature` from `@supabase-labs/middleware-openfeature` against an in-memory provider, with the targeting key and tenant taken from the resolved subject. `PATCH /hono/posts/:id` runs the same entries inside Hono through `src/to-hono.ts`, the bridge that replaces the deprecated `@supabase/server/adapters/hono`, and reads `c.var.permdock`. `GET /dev/token/member` and `GET /dev/token/admin` mint development tokens against an in-process ES256 key (a real deployment points `withClaims` at the project JWKS and never mints its own tokens). `pnpm start` listens on `127.0.0.1:3477`.

```ts
import { pipeline } from "@supabase/middleware";
import { withClaims } from "@supabase/server/middleware/claims";
import { subjectFromSupabase } from "permdock/supabase";
import { createPermDock } from "permdock/supabase/middleware";

const { withPermDock } = createPermDock(policy, {
  subject: (ctx) => subjectFromSupabase(ctx.jwtClaims, { roles: "user_role" }),
});

export default {
  fetch: pipeline([withClaims(), withPermDock()], async (req, ctx) => {
    if (!ctx.permdock.can(permissions.post.update, post)) {
      return new Response(null, { status: 403 });
    }
    return Response.json({ ok: true });
  }),
};
```
