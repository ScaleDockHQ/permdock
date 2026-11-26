import { joseTokenSigner } from "permdock/jwt";
import {
  memorySetQueue,
  memorySsfStreamStore,
  setPollHandler,
  ssfTransmitter,
} from "permdock/ssf";

import { env } from "../../../../env.ts";
import { issuer } from "../../../../lib/supabase/server.ts";
import { bearerToken } from "../../../../permdock/bearer.ts";

function transmitter(): {
  readonly transmit: (request: Request) => Promise<Response>;
  readonly poll: (request: Request) => Promise<Response>;
} | null {
  if (env.signingKey === undefined) {
    return null;
  }
  const parsed: unknown = JSON.parse(env.signingKey);
  if (parsed === null || typeof parsed !== "object" || !("kid" in parsed)) {
    return null;
  }
  const kid = parsed.kid;
  if (typeof kid !== "string") {
    return null;
  }
  const signer = joseTokenSigner({
    key: { ...parsed },
    alg: "ES256",
    kid,
    issuer,
  });
  const queue = memorySetQueue();
  const transmit = ssfTransmitter({
    issuer,
    endpoint: `${issuer}/api/ssf`,
    streams: memorySsfStreamStore(),
    queue,
    signer,
    authorize: (request) => bearerToken(request),
  });
  const poll = setPollHandler({
    queue,
    authorize: (request) => bearerToken(request),
  });
  return { transmit, poll };
}

const handlers = transmitter();

async function answer(request: Request): Promise<Response> {
  if (handlers === null) {
    return new Response(null, { status: 503 });
  }
  const url = new URL(request.url);
  const response = url.pathname.endsWith("/poll")
    ? await handlers.poll(request)
    : await handlers.transmit(request);
  return response;
}

export async function GET(request: Request): Promise<Response> {
  const response = await answer(request);
  return response;
}

export async function POST(request: Request): Promise<Response> {
  const response = await answer(request);
  return response;
}
