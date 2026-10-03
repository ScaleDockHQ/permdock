import type { JWTPayload } from 'jose';

import { SignJWT, exportJWK, generateKeyPair, importJWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AuthEvent } from '../../src/core/interfaces.ts';
import type { JwtSubjectOptions } from '../../src/jwt/index.ts';

import { createPermDock } from '../../src/core/permdock.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { allow, definePolicy, role } from '../../src/core/policy.ts';
import { subjectFromJwt } from '../../src/jwt/subject.ts';

const ISSUER = 'https://issuer.example';
const AUDIENCE = 'api://permdock-example';
const NOW = Math.floor(Date.now() / 1000);

let privateJwk: Record<string, unknown>;
let publicJwk: Record<string, unknown>;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'k1' };
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1' };
});

async function mapped(
  claims: JWTPayload,
  options: Partial<JwtSubjectOptions> = {},
) {
  const token = await new SignJWT({ sub: 'u_1', ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(NOW)
    .setExpirationTime(NOW + 300)
    .sign(await importJWK(privateJwk, 'ES256'));
  return subjectFromJwt(token, {
    jwks: { keys: [publicJwk] },
    issuer: ISSUER,
    audience: AUDIENCE,
    ...options,
  });
}

describe('RFC 9068 section 2.2.3.1 with the RFC 7643 section 4.1.2 encoding', () => {
  it('roles: a string array and SCIM complex values both become principal.roles', async () => {
    const plain = await mapped({ roles: ['admin', 'billing'] });
    const scim = await mapped({
      roles: [
        { value: 'admin', display: 'Administrator', primary: true },
        { value: 'billing', type: 'direct' },
      ],
    });
    expect(plain.principal?.roles).toEqual(['admin', 'billing']);
    expect(scim.principal?.roles).toEqual(['admin', 'billing']);
  });

  it('section 8.2: display is never the identifier, and values without value are dropped', async () => {
    const subject = await mapped({
      roles: [{ display: 'admin' }, { value: 7 }, null, 'viewer'],
    });
    expect(subject.principal?.roles).toEqual(['viewer']);
  });

  it('groups: each group is a membership of the active tenant with roles from groupRoles', async () => {
    const subject = await mapped(
      {
        org_id: 'o_acme',
        groups: [{ value: '9f2c', display: 'Design' }, '1b7e'],
      },
      { claims: { tenant: 'org_id' }, groupRoles: { '9f2c': ['lead'] } },
    );
    expect(subject.principal?.tenant).toBe('o_acme');
    expect(subject.principal?.memberships).toEqual([
      { tenant: 'o_acme', roles: ['lead'], via: 'group:9f2c' },
      { tenant: 'o_acme', roles: [], via: 'group:1b7e' },
    ]);
  });

  it('groups: without an active tenant no membership is minted', async () => {
    const subject = await mapped(
      { groups: ['9f2c'] },
      { groupRoles: { '9f2c': ['lead'] } },
    );
    expect(subject.principal?.memberships).toBeUndefined();
  });

  it('groups: groupRoles is keyed by id, so a display name never matches', async () => {
    const subject = await mapped(
      { org_id: 'o_acme', groups: [{ value: '9f2c', display: 'Design' }] },
      { claims: { tenant: 'org_id' }, groupRoles: { Design: ['lead'] } },
    );
    expect(subject.principal?.memberships).toEqual([
      { tenant: 'o_acme', roles: [], via: 'group:9f2c' },
    ]);
  });

  it('entitlements: string or SCIM values become principal.plans, not roles', async () => {
    const subject = await mapped({
      entitlements: ['pro', { value: 'sso' }],
    });
    expect(subject.principal?.plans).toEqual(['pro', 'sso']);
    expect(subject.principal?.roles).toBeUndefined();
  });

  it('the three claims are reserved and never copied into principal.claims', async () => {
    const subject = await mapped({
      roles: ['admin'],
      groups: ['g'],
      entitlements: ['pro'],
    });
    expect(subject.principal?.claims).toBeUndefined();
  });

  it('an Entra _claim_names overflow is not resolved into memberships', async () => {
    const subject = await mapped(
      {
        tid: 't_1',
        _claim_names: { groups: 'src1' },
        _claim_sources: { src1: { endpoint: 'https://graph.example/x' } },
      },
      { claims: { tenant: 'tid' } },
    );
    expect(subject.principal?.memberships).toBeUndefined();
  });
});

describe('Tenant claims: no standard exists, the path is configuration', () => {
  it('Descope: a tenants object keyed by tenant id maps to memberships', async () => {
    const subject = await mapped(
      {
        tenants: {
          T1: { roles: ['admin'], permissions: ['x'] },
          T2: { roles: ['viewer'] },
        },
      },
      { claims: { memberships: 'tenants' } },
    );
    expect(subject.principal?.memberships).toEqual([
      { tenant: 'T1', roles: ['admin'] },
      { tenant: 'T2', roles: ['viewer'] },
    ]);
  });

  it('Zitadel: role -> { orgId: domain } flattens into one membership per organisation', async () => {
    const subject = await mapped(
      {
        'urn:zitadel:iam:org:project:roles': {
          admin: { '2486': 'acme.zitadel.cloud' },
          viewer: {
            '2486': 'acme.zitadel.cloud',
            '9001': 'globex.zitadel.cloud',
          },
        },
      },
      { claims: { memberships: 'urn:zitadel:iam:org:project:roles' } },
    );
    expect(subject.principal?.memberships).toEqual([
      { tenant: '2486', roles: ['admin', 'viewer'] },
      { tenant: '9001', roles: ['viewer'] },
    ]);
  });

  it('Zitadel: a forbidden organisation key is not flattened', async () => {
    const subject = await mapped(
      {
        roles_claim: JSON.parse('{"admin":{"__proto__":"x"}}'),
      },
      { claims: { memberships: 'roles_claim' } },
    );
    expect(
      subject.principal?.memberships?.some(
        (membership) => membership.tenant === '__proto__',
      ) ?? false,
    ).toBe(false);
  });

  it('Auth0, WorkOS, Entra, Google, Kinde: the configured path is the active tenant', async () => {
    for (const path of ['org_id', 'tid', 'hd', 'org_code']) {
      const subject = await mapped(
        { [path]: 'o_1' },
        { claims: { tenant: path } },
      );
      expect({ path, tenant: subject.principal?.tenant }).toEqual({
        path,
        tenant: 'o_1',
      });
    }
  });

  it('an absent or non-string tenant claim yields no active tenant, never a default', async () => {
    expect(
      (await mapped({}, { claims: { tenant: 'org_id' } })).principal?.tenant,
    ).toBeUndefined();
    expect(
      (await mapped({ org_id: 42 }, { claims: { tenant: 'org_id' } })).principal
        ?.tenant,
    ).toBeUndefined();
  });
});

describe('Claims meet the policy', () => {
  const permissions = definePermissions({
    project: resource(z.object({ id: z.string(), orgId: z.string() }), {
      id: 'id',
      actions: ['read', 'delete'],
      relations: { org: { field: 'orgId', memberOf: 'tenant' } },
    }),
  });
  const policy = definePolicy(permissions, {
    principal: () => null,
    scopes: { tenant: { key: 'orgId' } },
    roles: [
      role('admin', [allow(permissions.project.delete)]),
      role('member', [allow(permissions.project.read)], { on: 'tenant' }),
    ],
  });

  it('undeclared role names grant nothing and are reported on auth', async () => {
    const events: AuthEvent[] = [];
    const subject = await mapped({ roles: ['superuser', 'admin'] });
    const permdock = await createPermDock(policy, subject);
    permdock.on('auth', (event) => {
      // SAFETY: the auth channel carries AuthEvent payloads.
      events.push(event as AuthEvent);
    });
    expect(
      permdock.can(permissions.project.delete, { id: 'p', orgId: 'o' }),
    ).toBe(true);
    expect(events).toContainEqual({ reason: 'unknown-role', source: 'roles' });
  });

  it('a group membership grants the tenant role only in its tenant', async () => {
    const subject = await mapped(
      { org_id: 'o_acme', groups: ['9f2c'] },
      { claims: { tenant: 'org_id' }, groupRoles: { '9f2c': ['member'] } },
    );
    const permdock = await createPermDock(policy, subject);
    expect(
      permdock.can(permissions.project.read, { id: 'p', orgId: 'o_acme' }),
    ).toBe(true);
    expect(
      permdock.can(permissions.project.read, { id: 'p', orgId: 'o_globex' }),
    ).toBe(false);
  });
});
