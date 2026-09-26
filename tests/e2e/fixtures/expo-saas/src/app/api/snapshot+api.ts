import { noStore, server, signer } from '../../lib/server';

/** The signed snapshot: a JSON string holding a `permdock-snapshot+jwt` JWS. */
export async function GET(request: Request): Promise<Response> {
  const permdock = await server.permdock(request);
  const jws = await permdock.snapshot({ signer });
  return Response.json(jws, { headers: noStore });
}
