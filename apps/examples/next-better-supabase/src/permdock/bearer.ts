import "server-only";
import { joseTokenVerifier, subjectFromJwt } from "permdock/jwt";

import { env } from "../env.ts";
import { audience } from "../lib/supabase/index.ts";
import { issuer } from "../lib/supabase/server.ts";

const verifier = joseTokenVerifier({
  jwks: env.verificationKeys ?? `${issuer}/.well-known/jwks.json`,
  issuer,
  audience,
});

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length);
  return token === "" ? null : token;
}

/** The bearer token, verified with PermDock's jose verifier. */
export async function subjectFromBearer(request: Request) {
  const subject = await subjectFromJwt(bearerToken(request), {
    verifier,
    issuer,
    audience,
  });
  return subject;
}

/** Handlers that match a root path see the request without this prefix. */
export function withoutPrefix(request: Request, prefix: string): Request {
  const url = new URL(request.url);
  if (url.pathname.startsWith(prefix)) {
    const rest = url.pathname.slice(prefix.length);
    url.pathname = rest === "" ? "/" : rest;
  }
  return new Request(url, request);
}
