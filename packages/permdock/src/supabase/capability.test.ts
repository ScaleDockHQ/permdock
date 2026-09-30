import {
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  jwtVerify,
} from 'jose';
import { describe, expect, it } from 'vitest';

import { capabilityOf, capabilitySubject } from '../core/capability.ts';
import { definePermissions, resource } from '../core/permissions.ts';
import { exchangeCapability } from './capability.ts';

const permissions = definePermissions({
  quote: resource({ actions: ['read', 'accept'] }),
});
const SECRET = 'super-secret-jwt-token-with-at-least-32-characters';
const NOW = 1_900_000_000;
const pair = generateKeyPair('ES256', { extractable: true });

async function es256() {
  const { privateKey, publicKey } = await pair;
  return {
    publicKey,
    signing: {
      key: await exportJWK(privateKey),
      alg: 'ES256',
      kid: 'permdock-links',
    } as const,
  };
}

function linkSubject(expiresAt = NOW + 86_400) {
  return capabilitySubject(
    capabilityOf({
      id: 'lnk_1',
      on: { resource: permissions.quote, id: 'q_1' },
      roles: ['guest'],
      permissions: [permissions.quote.read],
      expiresAt,
    }),
  );
}

describe('exchangeCapability', () => {
  it('mints a short-lived anon token carrying the capability', async () => {
    const { publicKey, signing } = await es256();
    const token = await exchangeCapability(linkSubject(), {
      ...signing,
      issuer: 'https://ref.supabase.co/auth/v1',
      now: NOW,
    });
    const { payload } = await jwtVerify(token ?? '', publicKey, {
      currentDate: new Date(NOW * 1000),
    });
    expect(payload).toEqual({
      role: 'anon',
      iss: 'https://ref.supabase.co/auth/v1',
      iat: NOW,
      exp: NOW + 300,
      capability: {
        v: 1,
        id: 'lnk_1',
        holder: 'link',
        on: { resource: 'quote', id: 'q_1' },
        roles: ['guest'],
        permissions: ['quote.read'],
        expiresAt: NOW + 86_400,
      },
    });
    expect(payload).not.toHaveProperty('sub');
  });

  it('never outlives the capability', async () => {
    const { publicKey, signing } = await es256();
    const token = await exchangeCapability(linkSubject(NOW + 30), {
      ...signing,
      ttl: 600,
      now: NOW,
    });
    const { payload } = await jwtVerify(token ?? '', publicKey, {
      currentDate: new Date(NOW * 1000),
    });
    expect(payload.exp).toBe(NOW + 30);
    await expect(
      exchangeCapability(linkSubject(NOW - 1), { ...signing, now: NOW }),
    ).resolves.toBeUndefined();
  });

  it('signs with an imported asymmetric key and its kid', async () => {
    const { signing } = await es256();
    const token = await exchangeCapability(linkSubject(), {
      ...signing,
      now: NOW,
    });
    expect(decodeProtectedHeader(token ?? '')).toEqual({
      alg: 'ES256',
      kid: 'permdock-links',
      typ: 'JWT',
    });
  });

  it('still signs with the legacy shared secret', async () => {
    const token = await exchangeCapability(linkSubject(), {
      key: { secret: SECRET },
      alg: 'HS256',
      now: NOW,
    });
    expect(decodeProtectedHeader(token ?? '')).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
    const { payload } = await jwtVerify(
      token ?? '',
      new TextEncoder().encode(SECRET),
      { currentDate: new Date(NOW * 1000) },
    );
    expect(payload.role).toBe('anon');
  });

  it('exchanges only a link subject', async () => {
    const { signing } = await es256();
    const options = { ...signing, now: NOW };
    await expect(
      exchangeCapability({ principal: null, context: {} }, options),
    ).resolves.toBeUndefined();
    await expect(
      exchangeCapability(
        { principal: { id: 'u_1', roles: ['admin'] }, context: {} },
        options,
      ),
    ).resolves.toBeUndefined();
    await expect(
      exchangeCapability(
        {
          principal: { id: 'lnk_1', kind: 'link', capability: { v: 1 } },
          context: {},
        },
        options,
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses a key that does not match the algorithm', async () => {
    await expect(
      exchangeCapability(linkSubject(), {
        key: { secret: SECRET },
        alg: 'ES256',
        kid: 'k',
      }),
    ).rejects.toThrow(/HS256 with \{ secret \} only/u);
    await expect(
      exchangeCapability(linkSubject(), { key: { kty: 'EC' }, alg: 'ES256' }),
    ).rejects.toThrow(/kid/u);
  });
});
