import "server-only";
import { env } from "../../env.ts";
import { betterSupabase } from "../../lib/supabase/index.ts";
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
    const sql = ctx.sql;
    if (sql === undefined) {
      throw new Error("quotes_overview_payload needs the postgres client");
    }
    const result = await sql.$rpc("quotes_overview_payload");
    if (!result.ok) {
      throw new Error("quotes_overview_payload failed", {
        cause: result.error,
      });
    }
    return { organization, total: result.data };
  },
  {
    share: env.without === "shared-cache" ? "user" : "tenant",
    functions: ["quotes_overview_payload"],
    tenant: (organization: string) => organization,
    name: "quotes-overview",
  },
);
