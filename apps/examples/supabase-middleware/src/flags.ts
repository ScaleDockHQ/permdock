import type { BaseContext } from "@supabase/middleware";
import type { PermDock } from "permdock";

import { OpenFeature, TypedInMemoryProvider } from "@openfeature/server-sdk";
import { withOpenFeature } from "@supabase-labs/middleware-openfeature";
import { pipeline } from "@supabase/middleware";
import { withFeatureFlag } from "@supabase/middleware/feature-flag";
import { withClaims } from "@supabase/server/middleware/claims";

import { jwks } from "./keys.ts";
import { withPermDock } from "./permdock.ts";
import { ownPost, permissions } from "./permissions.ts";

const DOMAIN = "permdock-example";

// Stands in for the app's flag vendor: any OpenFeature server provider fits.
await OpenFeature.setProviderAndWait(
  DOMAIN,
  new TypedInMemoryProvider({
    "beta-editor": {
      variants: { on: true, off: false },
      defaultVariant: "off",
      disabled: false,
      contextEvaluator: (ctx) => (ctx["tenant"] === "o1" ? "on" : "off"),
    },
  }),
);

function isPermDock(value: unknown): value is PermDock {
  return (
    typeof value === "object" &&
    value !== null &&
    "can" in value &&
    typeof value.can === "function" &&
    "subject" in value
  );
}

/**
 * `ctx.permdock` from an upstream `withPermDock()`. `withFeatureFlag` types its
 * `evaluate` context as `BaseContext`, so the contribution is read through a guard.
 */
function permdockOf(ctx: BaseContext): PermDock | null {
  const value: unknown = Reflect.get(ctx, "permdock");
  return isPermDock(value) ? value : null;
}

// A flag gated on a permission: anyone without `post.review` gets the flag's
// 404, so the queue's existence is not revealed the way a 403 would.
export const reviewQueue = pipeline(
  [
    withClaims({ jwks }),
    withPermDock(),
    withFeatureFlag({
      name: "review-queue",
      evaluate: (_request, ctx) =>
        permdockOf(ctx)?.can(permissions.post.review) === true,
    }),
  ],
  async (): Promise<Response> => {
    await Promise.resolve();
    return Response.json({ queue: [ownPost.id] });
  },
);

// OpenFeature targets the resolved subject: the user and tenant PermDock read
// from the verified claims, never a header the client sets.
export const flags = pipeline(
  [
    withClaims({ jwks }),
    withPermDock(),
    withOpenFeature({
      client: OpenFeature.getClient(DOMAIN),
      flags: { "beta-editor": false },
      context: (_request, ctx: { readonly permdock: PermDock }) => {
        const user = ctx.permdock.subject.principal;
        const tenant = user?.tenant;
        return {
          targetingKey: user?.id ?? "anonymous",
          ...(typeof tenant === "string" ? { tenant } : {}),
        };
      },
    }),
  ],
  async (_request, ctx): Promise<Response> => {
    await Promise.resolve();
    return Response.json(ctx.flags);
  },
);
