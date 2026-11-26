import { sqlTransport } from "better-supabase/blocks";
import { createApiKeys } from "better-supabase/blocks/api-keys";
import { apiKeyVerifier } from "permdock/better-supabase";

import { postgres } from "../../../../lib/supabase/server.ts";
import { bearerToken } from "../../../../permdock/bearer.ts";
import { permissions } from "../../../../policy.ts";

const keys = createApiKeys({ transport: sqlTransport(postgres.admin) });

const verifier = apiKeyVerifier({
  // SAFETY: permdock and this app resolve better-supabase twice, so AsyncResult is a distinct nominal type.
  keys: keys as unknown as Parameters<typeof apiKeyVerifier>[0]["keys"],
  serviceRoles: ["member"],
  allPermissions: [permissions.quotes.list, permissions.quotes.read],
});

export async function GET(request: Request): Promise<Response> {
  const secret = bearerToken(request);
  if (secret === null) {
    return new Response(null, { status: 401 });
  }
  const credential = await verifier.verify(secret);
  const tenant = credential?.tenant;
  if (tenant === undefined) {
    return new Response(null, { status: 401 });
  }
  const rows = await postgres.admin.queryRaw(
    `select id, title from public.quotes
     where organization_id = $1
     order by title
     limit 50`,
    [tenant],
  );
  return Response.json(rows);
}
