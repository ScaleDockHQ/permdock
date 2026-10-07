import type {
  AnyEntry,
  Contributions,
  ValidateEntries,
} from "@supabase/middleware";
import type { Context, MiddlewareHandler, Next } from "hono";

import { bufferRequest, pipeline, seedContext } from "@supabase/middleware";
import { createMiddleware } from "hono/factory";

type Bridge<Entries extends readonly AnyEntry[]> = [
  ValidateEntries<Entries>,
] extends [true]
  ? MiddlewareHandler<{ Variables: Contributions<Entries> }>
  : ValidateEntries<Entries>;

const HANDOFF = Symbol("toHono.handoff");

type Handoff = { readonly c: Context; readonly next: Next };

function isHandoff(value: unknown): value is Handoff {
  return typeof value === "object" && value !== null && "c" in value;
}

/**
 * Runs `@supabase/middleware` entries in Hono's middleware slot and publishes
 * every contribution on `c.var`, so a route reads `c.var.permdock`. Register it
 * with a chained `.use()` before the routes it gates: Hono types `c.var` only
 * through the chain.
 */
export function toHono<const Entries extends readonly AnyEntry[]>(
  entries: Entries,
): Bridge<Entries> {
  const run = pipeline(entries, async (_request, ctx) => {
    const handoff: unknown = Reflect.get(ctx, HANDOFF);
    if (!isHandoff(handoff)) {
      throw new Error("toHono: the pipeline ran outside its Hono middleware");
    }
    const { c, next } = handoff;
    for (const [key, value] of Object.entries(ctx)) {
      // SAFETY: Bridge types c.var as exactly the keys the entries contribute.
      c.set(key as never, value as never);
    }
    await next();
    return c.res;
  });

  const middleware = createMiddleware(async (c, next) => {
    // The engine buffers a body only when it seeds the context itself; this
    // bridge seeds, so it buffers, and the route reads the same cached body.
    if (c.req.raw.body !== null) {
      c.req.raw = bufferRequest(c.req.raw);
    }
    const response = await run(c.req.raw, {
      ...seedContext(c.env),
      [HANDOFF]: { c, next } satisfies Handoff,
    });
    if (response !== c.res) {
      // Hono's `res` setter copies the previous headers onto the new response,
      // which would undo a header the response phase rewrote.
      // SAFETY: Hono's setter treats a falsy value as a reset, not a response.
      c.res = null as never;
      c.res = response;
    }
  });
  return middleware;
}
