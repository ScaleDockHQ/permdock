import { type JSONWebKeySet, SignJWT, exportJWK, generateKeyPair } from 'jose';

// Development-only signing key. A real deployment points `withClaims` at the
// project JWKS (`https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`) and
// never mints tokens itself; Supabase Auth does.
const KID = 'dev-1';
export const ISSUER = 'http://127.0.0.1:3477/auth/v1';

const { privateKey, publicKey } = await generateKeyPair('ES256', {
  extractable: true,
});

export const jwks: JSONWebKeySet = {
  keys: [
    { ...(await exportJWK(publicKey)), kid: KID, alg: 'ES256', use: 'sig' },
  ],
};

export type DevUser = 'member' | 'admin';

const CLAIMS: Record<DevUser, Record<string, unknown>> = {
  member: {
    sub: 'u1',
    role: 'authenticated',
    user_role: 'member',
    tenant_id: 'o1',
    memberships: [{ tenant: 'o1', roles: ['member'] }],
  },
  admin: {
    sub: 'u2',
    role: 'authenticated',
    user_role: 'admin',
    tenant_id: 'o1',
    memberships: [{ tenant: 'o1', roles: ['admin'] }],
  },
};

export function isDevUser(value: string): value is DevUser {
  return value === 'member' || value === 'admin';
}

export async function mintToken(user: DevUser): Promise<string> {
  const token = await new SignJWT(CLAIMS[user])
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
  return token;
}
