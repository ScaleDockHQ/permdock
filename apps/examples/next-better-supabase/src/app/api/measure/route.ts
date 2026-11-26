import { env } from "../../../env.ts";
import { bsb, versions } from "../../../lib/supabase/server.ts";

/**
 * One verified session read, timed. `scripts/measure.ts` calls it cold and
 * warm. A build without `MEASURE=1` answers 404.
 */
export async function GET(): Promise<Response> {
  if (!env.measure) {
    return new Response(null, { status: 404 });
  }
  const started = performance.now();
  const snapshot = await bsb.getClaims();
  return Response.json({
    verifyMs: performance.now() - started,
    userId: snapshot?.userId ?? null,
    versions: versions.stats(),
  });
}
