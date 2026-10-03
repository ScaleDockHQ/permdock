import type { NextRequest } from 'next/server';

import { importJWK, SignJWT } from 'jose';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { env } from '../../../../env.ts';
import { audience, cookieName } from '../../../../lib/supabase/index.ts';
import { issuer, postgres } from '../../../../lib/supabase/server.ts';

const SignIn = z.object({
  user: z.uuid(),
  next: z.string().startsWith('/'),
});

const HookEvent = z.object({
  claims: z.looseObject({ sub: z.string() }),
});

const SigningKey = z.looseObject({ kty: z.string(), kid: z.string() });

const TTL = 900;

/** The claims Supabase Auth would issue, after the PermDock access-token hook ran as `supabase_auth_admin`. */
async function hookClaims(
  user: string,
  now: number,
): Promise<z.infer<typeof HookEvent>['claims']> {
  const event = {
    user_id: user,
    authentication_method: 'password',
    claims: {
      sub: user,
      role: 'authenticated',
      aud: audience,
      iss: issuer,
      iat: now,
      exp: now + TTL,
      aal: 'aal1',
      amr: [{ method: 'password', timestamp: now }],
      session_id: crypto.randomUUID(),
      is_anonymous: false,
    },
  };
  const [row] = await postgres.transaction(async (client) => {
    await client.queryRaw('set local role supabase_auth_admin');
    return client.queryRaw<{ event: unknown }>(
      'select permdock.custom_access_token_hook($1::jsonb) as event',
      [JSON.stringify(event)],
    );
  });
  return HookEvent.parse(row?.event).claims;
}

/** The `@supabase/ssr` cookie value: `base64-` and the base64url session JSON. */
function sessionCookie(token: string, user: string, now: number): string {
  const session = {
    access_token: token,
    refresh_token: crypto.randomUUID(),
    token_type: 'bearer',
    expires_in: TTL,
    expires_at: now + TTL,
    user: { id: user },
  };
  return `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;
}

/** E2e build only: what Supabase Auth does at sign-in, against the inline JWKS's private key. */
export async function GET(request: NextRequest): Promise<Response> {
  if (!env.e2e || typeof env.signingKey !== 'string') {
    return new Response(null, { status: 404 });
  }
  const input = SignIn.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!input.success) {
    return new Response(null, { status: 400 });
  }
  const now = Math.floor(Date.now() / 1000);
  const claims = await hookClaims(input.data.user, now);
  const jwk = SigningKey.parse(JSON.parse(env.signingKey));
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'JWT' })
    .sign(await importJWK(jwk, 'ES256'));
  // Relative, so the browser stays on the host the cookie was set for.
  const response = new NextResponse(null, {
    status: 303,
    headers: { location: input.data.next },
  });
  response.cookies.set(cookieName, sessionCookie(token, input.data.user, now), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
  });
  return response;
}
