import "server-only";
import { env } from "../../env.ts";
import { bsb } from "../../lib/supabase/server.ts";

/**
 * One entry for every caller in the tenant who holds `quotes.list` on the same
 * terms. `quotes` is a row table, so the function reads none and calls the
 * permission filter; without `MEASURE_WITHOUT=shared-cache` the fill is `share:
 * "tenant"`.
 */
export const quotesOverview = bsb.kept(
  async (ctx, organization: string) => {
    // SAFETY: quotes_overview_payload is granted to authenticated. The generated
    // Database type lists only the functions better-supabase gen saw.
    const call = ctx.supabase.rpc.bind(ctx.supabase) as unknown as (
      fn: string,
    ) => Promise<{ readonly data: unknown }>;
    const result = await call("quotes_overview_payload");
    return {
      organization,
      total: typeof result.data === "number" ? result.data : 0,
    };
  },
  {
    share: env.without === "shared-cache" ? "user" : "tenant",
    functions: ["quotes_overview_payload"],
    tenant: (organization: string) => organization,
    name: "quotes-overview",
  },
);
