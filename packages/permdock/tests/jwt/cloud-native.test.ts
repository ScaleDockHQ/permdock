import { SignJWT, importJWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createPermDock } from '../../src/core/permdock.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { allow, definePolicy } from '../../src/core/policy.ts';
import { definePlans, defineRoles } from '../../src/core/vocabulary.ts';
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
      kid: 'cloud-2026-09',
      alg: 'Ed25519',
      use: 'sig',
    },
  ],
};

const CLOUD_ISSUER = 'https://api.permdock.test/v1/environments/production';
const APP = 'https://app.example.com';

const permissions = definePermissions({
  doc: resource(z.object({ id: z.string(), orgId: z.string() }), {
    id: 'id',
    actions: ['read', 'update'],
    relations: { org: { field: 'orgId', memberOf: 'tenant' } },
  }),
  report: resource(z.object({ id: z.string(), orgId: z.string() }), {
    id: 'id',
    actions: ['export'],
    relations: { org: { field: 'orgId', memberOf: 'tenant' } },
  }),
});

const roles = defineRoles({
  editor: { on: 'tenant' },
  viewer: { on: 'tenant' },
});
const plans = definePlans({ pro: {} });

const policy = definePolicy(
  { permissions, roles, plans },
  {
    scopes: { tenant: { key: 'orgId' } },
    subject: () => null,
    grants: [
      allow(permissions.doc.read, { to: [roles.viewer] }),
      allow(permissions.doc.read, { to: [roles.editor] }),
      allow(permissions.doc.update, { to: [roles.editor] }),
      allow(permissions.report.export, { to: [roles.editor, plans.pro] }),
    ],
  },
);

async function cloudToken(
  claims: Record<string, unknown>,
  audience = APP,
): Promise<string> {
  const key = await importJWK({ ...PRIVATE_JWK }, 'Ed25519');
  return new SignJWT({ sub: 'u_1', client_id: 'app', ...claims })
    .setProtectedHeader({ alg: 'Ed25519', kid: 'cloud-2026-09', typ: 'at+jwt' })
    .setIssuer(CLOUD_ISSUER)
    .setAudience(audience)
    .setIssuedAt(1_700_000_000)
    .setExpirationTime(2_000_000_000)
    .sign(key);
}

function subjectOf(token: string): ReturnType<typeof subjectFromJwt> {
  return subjectFromJwt(token, {
    jwks: JWKS,
    issuer: CLOUD_ISSUER,
    audience: APP,
    algorithms: ['Ed25519'],
    claims: { tenant: 'tenant', memberships: 'memberships' },
  });
}

const acmeDoc = { id: 'd1', orgId: 'o_acme' };
const globexDoc = { id: 'd2', orgId: 'o_globex' };

describe('Cloud-native directory mode', () => {
  it('decides locally from memberships and entitlements on the Cloud token', async () => {
    const token = await cloudToken({
      tenant: 'o_acme',
      memberships: [
        { tenant: 'o_acme', roles: ['editor'] },
        { tenant: 'o_globex', roles: ['viewer'] },
      ],
      entitlements: ['pro'],
    });
    const permdock = await createPermDock(policy, await subjectOf(token));
    expect(permdock.can(permissions.doc.update, acmeDoc)).toBe(true);
    expect(permdock.can(permissions.report.export, acmeDoc)).toBe(true);
    expect(permdock.can(permissions.doc.update, globexDoc)).toBe(false);
  });

  it('drops a role the policy never declared', async () => {
    const token = await cloudToken({
      tenant: 'o_acme',
      memberships: [{ tenant: 'o_acme', roles: ['superadmin'] }],
    });
    const permdock = await createPermDock(policy, await subjectOf(token));
    expect(permdock.can(permissions.doc.read, acmeDoc)).toBe(false);
  });

  it('never defaults a requested tenant without a membership', async () => {
    const token = await cloudToken({
      tenant: 'o_initech',
      memberships: [{ tenant: 'o_acme', roles: ['editor'] }],
    });
    const permdock = await createPermDock(policy, await subjectOf(token));
    expect(permdock.subject.principal?.tenant).toBeUndefined();
  });

  it('treats a token for another application as anonymous', async () => {
    const token = await cloudToken(
      {
        tenant: 'o_acme',
        memberships: [{ tenant: 'o_acme', roles: ['editor'] }],
      },
      'https://other.example.com',
    );
    const subject = await subjectOf(token);
    expect(subject.principal).toBeNull();
    const permdock = await createPermDock(policy, subject);
    expect(permdock.can(permissions.doc.read, acmeDoc)).toBe(false);
  });
});
