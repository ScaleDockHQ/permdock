import { env } from "../../../env.ts";
import { bsb } from "../../../lib/supabase/server.ts";

/**
 * Per-request database totals. Absent unless the process was built with
 * `MEASURE=1`, so a normal build answers 404 for a path it does not serve.
 */
export async function GET(request: Request): Promise<Response> {
  if (!env.measure) {
    return new Response(null, { status: 404 });
  }
  const response = await bsb.debugRoute()(request);
  return response;
}
