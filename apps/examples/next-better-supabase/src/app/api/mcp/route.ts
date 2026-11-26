import { createMcp } from "better-supabase/mcp";
import { getPermDock } from "permdock";
import {
  subjectFromBetterSupabase,
  toolPolicy,
} from "permdock/better-supabase";

import { betterSupabase } from "../../../lib/supabase/index.ts";
import { postgres } from "../../../lib/supabase/server.ts";
import { appPolicy, permissions } from "../../../policy.ts";

type Auth = Parameters<typeof subjectFromBetterSupabase>[0];

const mcp = createMcp(betterSupabase, {
  name: "permdock-example",
  version: "0.0.0",
  ...toolPolicy({
    permdock: async (ctx: { auth: Auth }) => {
      const permdock = await getPermDock(
        appPolicy,
        subjectFromBetterSupabase(ctx.auth),
      );
      return permdock;
    },
  }),
}).tool({
  name: "quotes_list",
  description: "List the quotes this caller may read.",
  meta: permissions.quotes.list,
  run: async () => {
    const rows = await postgres.admin.queryRaw(
      "select id, title from public.quotes order by title limit 50",
    );
    return rows;
  },
});

export async function POST(request: Request): Promise<Response> {
  const response = await mcp.fetch(request);
  return response;
}

export async function GET(request: Request): Promise<Response> {
  const response = await mcp.fetch(request);
  return response;
}
