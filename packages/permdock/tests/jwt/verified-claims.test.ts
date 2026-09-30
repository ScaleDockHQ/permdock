import { SignJWT, importJWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { principal } from '../../src/conditions/refs.ts';
import { createPermDock } from '../../src/core/permdock.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { allow, definePolicy, role } from '../../src/core/policy.ts';
import { subjectFromJwt } from '../../src/jwt/subject.ts';

const PRIVATE_JWK = {
  crv: 'Ed25519',
  d: 'qco_Uh5slpzay2a-eC3woOxpC4DlS6aEzLtBRjrdtd4',
  x: '79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ',
  kty: 'OKP',
} as const;
const JWKS = {
  keys: [
    {
      crv: 'Ed25519',
      x: '79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ',
      kty: 'OKP',
      kid: 'idp-1',
      alg: 'Ed25519',
    },
  ],
};
const ISSUER = 'https://idp.example.com';
const APP = 'https://bank.example.com';

const EIDAS = {
  verification: {
    trust_framework: 'eidas',
    assurance_level: 'substantial',
    evidence: [{ type: 'electronic_record' }],
  },
  claims: { given_name: 'Ada', birthdate: '1990-01-01' },
};

async function token(claims: Record<string, unknown>): Promise<string> {
  const key = await importJWK({ ...PRIVATE_JWK }, 'Ed25519');
  return new SignJWT({
    sub: 'u_1',
    client_id: 'bank',
    roles: ['customer'],
    ...claims,
  })
    .setProtectedHeader({ alg: 'Ed25519', kid: 'idp-1', typ: 'at+jwt' })
    .setIssuer(ISSUER)
    .setAudience(APP)
    .setIssuedAt(1_700_000_000)
    .setExpirationTime(2_000_000_000)
    .sign(key);
}

async function assuranceOf(claims: Record<string, unknown>) {
  const subject = await subjectFromJwt(await token(claims), {
    jwks: JWKS,
    issuer: ISSUER,
    audience: APP,
    algorithms: ['Ed25519'],
  });
  return subject.principal?.assurance;
}

describe('verified_claims', () => {
  it('maps one object or an array into frozen evidence', async () => {
    const single = await assuranceOf({ verified_claims: EIDAS, acr: 'high' });
    expect(single).toEqual({ acr: 'high', verified: [EIDAS] });
    expect(Object.isFrozen(single?.verified?.[0]?.verification)).toBe(true);
    const many = await assuranceOf({
      verified_claims: [
        EIDAS,
        { verification: { trust_framework: 'uk_tfida' }, claims: {} },
      ],
    });
    expect(
      many?.verified?.map((entry) => entry.verification.trust_framework),
    ).toEqual(['eidas', 'uk_tfida']);
  });

  it('drops entries without a trust framework, claims or with unsafe keys', async () => {
    const assurance = await assuranceOf({
      verified_claims: [
        { verification: {}, claims: {} },
        { verification: { trust_framework: 'eidas' } },
        JSON.parse(
          '{"verification":{"trust_framework":"eidas"},"claims":{"__proto__":{"admin":true}}}',
        ),
        'eidas',
      ],
    });
    expect(assurance).toBeUndefined();
  });

  it('is a condition ref', async () => {
    const permissions = definePermissions({
      account: resource(z.object({ id: z.string(), framework: z.string() }), {
        id: 'id',
        actions: ['open'],
      }),
    });
    const policy = definePolicy(permissions, {
      roles: [
        role('customer', [
          allow(permissions.account.open, {
            where: {
              framework:
                principal.assurance['verified']['0']['verification'][
                  'trust_framework'
                ],
            },
          }),
        ]),
      ],
      subject: () => null,
    });
    const verified = await subjectFromJwt(
      await token({ verified_claims: EIDAS }),
      { jwks: JWKS, issuer: ISSUER, audience: APP, algorithms: ['Ed25519'] },
    );
    const plain = await subjectFromJwt(await token({}), {
      jwks: JWKS,
      issuer: ISSUER,
      audience: APP,
      algorithms: ['Ed25519'],
    });
    const eu = { id: 'a1', framework: 'eidas' };
    expect(
      (await createPermDock(policy, verified)).can(
        permissions.account.open,
        eu,
      ),
    ).toBe(true);
    expect(
      (await createPermDock(policy, plain)).can(permissions.account.open, eu),
    ).toBe(false);
  });
});
