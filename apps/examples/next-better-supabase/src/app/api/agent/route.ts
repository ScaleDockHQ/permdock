import { decodeJwt } from "jose";

import type { CallerQuery } from "../../../agent/tools.ts";

import { quoteAgent } from "../../../agent/tools.ts";
import { postgres } from "../../../lib/supabase/server.ts";
import { bearerToken, subjectFromBearer } from "../../../permdock/bearer.ts";
import { organizationId, orgHeader } from "../../../permdock/request.ts";

export async function POST(request: Request): Promise<Response> {
  const token = bearerToken(request);
  const subject = await subjectFromBearer(request);
  const slug = request.headers.get(orgHeader);
  if (token === null || subject.principal === null || slug === null) {
    return new Response(null, { status: 401 });
  }
  const tenant = await organizationId(slug);
  if (tenant === undefined) {
    return new Response(null, { status: 404 });
  }
  const claims = decodeJwt(token);
  const query: CallerQuery = async (sql, params) => {
    const rows = await postgres
      .asUser(claims)
      .queryRaw(sql, params === undefined ? [] : [...params]);
    return rows;
  };
  const result = await quoteAgent({
    subject,
    organization: tenant,
    query,
  }).call("quotes.read");
  return Response.json(result);
}
