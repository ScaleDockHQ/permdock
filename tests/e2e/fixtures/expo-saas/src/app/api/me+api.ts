import { findOrg } from "@permdock/e2e-saas-kit";

import { noStore, orgOf, sessionOf } from "../../lib/server";

export async function GET(request: Request): Promise<Response> {
  const session = await sessionOf(request);
  const org = findOrg(orgOf(request));
  return Response.json(
    { user: session?.sub ?? null, plan: org?.plan ?? null },
    { headers: noStore },
  );
}
