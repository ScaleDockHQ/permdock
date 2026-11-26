import "server-only";
import { env } from "../../env.ts";
import { betterSupabase } from "../../lib/supabase/index.ts";
import { postgres } from "../../lib/supabase/runtime.ts";
import { bsb } from "../../lib/supabase/server.ts";
import { quote_overviewsTable } from "../../lib/supabase/tables/quote-overviews.ts";

// Lazy table metadata is empty until a query registers the table. The shared
// fill checks it before the function runs, so register the tenant table first.
betterSupabase.registerTable(quote_overviewsTable);

/**
 * One entry for every caller in the tenant who holds `quotes.list` on the same
 * terms. `quotes` is a row table, so the function reads none and calls the
 * permission filter; without `MEASURE_WITHOUT=shared-cache` the fill is `share:
 * "tenant"`.
 */
export const quotesOverview = bsb.kept(
  async (ctx, organization: string) => {
    // The session token names no tenant, and has_active reads tenant_id.
    // A signed-out render has no execute grant; shareKey stores nothing for it.
    if (ctx.auth.kind !== "user") {
      return { organization, total: 0 };
    }
    const rows = await postgres
      .asUser({
        ...ctx.auth.claims,
        sub: ctx.auth.user.id,
        role: "authenticated",
        tenant_id: organization,
      })
      .queryRaw<{ readonly total: number | null }>(
        "select public.quotes_overview_payload() as total",
      );
    const total = rows[0]?.total;
    return { organization, total: typeof total === "number" ? total : 0 };
  },
  {
    share: env.without === "shared-cache" ? "user" : "tenant",
    functions: ["quotes_overview_payload"],
    tenant: (organization: string) => organization,
    name: "quotes-overview",
  },
);
