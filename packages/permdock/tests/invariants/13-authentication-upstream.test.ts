import { SignJWT, importJWK } from 'jose';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  resource,
  role,
} from '../../src/index.ts';
import { subjectFromJwt } from '../../src/jwt/index.ts';
import { createPermDock as createServerPermDock } from '../../src/server/index.ts';
import { subjectFromSupabase } from '../../src/supabase/index.ts';

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
} as const;
const ISSUER = 'https://idp.example.com';
const AUDIENCE = 'https://api.example.com';
const jwtOptions = {
  jwks: JWKS,
  issuer: ISSUER,
  audience: AUDIENCE,
  algorithms: ['Ed25519'],
} as const;

const base64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

async function signed(claims: Record<string, unknown>): Promise<string> {
  const key = await importJWK({ ...PRIVATE_JWK }, 'Ed25519');
  return new SignJWT({
    sub: 'u1',
    roles: ['member'],
    iss: ISSUER,
    aud: AUDIENCE,
    ...claims,
  })
    .setProtectedHeader({ alg: 'Ed25519', kid: 'idp-1', typ: 'at+jwt' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

const Project = z.object({ id: z.string(), orgId: z.string() });
const permissions = definePermissions({
  project: resource(Project, {
    id: 'id',
    actions: ['read'],
    relations: { organization: { field: 'orgId', memberOf: 'organization' } },
  }),
});
type User = {
  readonly id: string;
  readonly memberships: readonly {
    readonly scope: string;
    readonly id: string;
    readonly roles: readonly string[];
  }[];
};
const policy = definePolicy(permissions, {
  scopes: { organization: { key: 'orgId' } },
  roles: [
    role('viewer', [allow(permissions.project.read)], { on: 'organization' }),
  ],
  subject: (user: User | null) =>
    user === null ? null : { id: user.id, memberships: user.memberships },
});
const viewer: User = {
  id: 'u1',
  memberships: [{ scope: 'organization', id: 'o1', roles: ['viewer'] }],
};

const src = path.join(import.meta.dirname, '../../src');

describe('invariant 13: authentication is upstream', () => {
  it('never verifies a token in core', () => {
    const offenders: string[] = [];
    for (const dir of ['core', 'conditions']) {
      for (const file of readdirSync(path.join(src, dir), { recursive: true })
        .map(String)
        .filter((name) => name.endsWith('.ts'))) {
        const text = readFileSync(path.join(src, dir, file), 'utf8');
        if (/from 'jose'|subtle\.verify|createVerify/u.test(text)) {
          offenders.push(`${dir}/${file}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('turns an unverifiable token into the anonymous subject, never a throw', async () => {
    const valid = await signed({});
    const [header, payload] = valid.split('.');
    const unsigned = `${base64url({ alg: 'none', typ: 'at+jwt' })}.${String(payload)}.`;
    const tampered = `${String(header)}.${base64url({ sub: 'admin', roles: ['admin'], iss: ISSUER, aud: AUDIENCE })}.${valid.split('.')[2] ?? ''}`;
    for (const token of [
      unsigned,
      tampered,
      'not-a-jwt',
      '',
      await signed({ iss: 'https://evil.example' }),
      await signed({ aud: 'https://other.example' }),
    ]) {
      const subject = await subjectFromJwt(token, jwtOptions);
      expect(subject.principal).toBeNull();
    }
    expect((await subjectFromJwt(valid, jwtOptions)).principal?.id).toBe('u1');
  });

  it('never builds grants from user_metadata', () => {
    const mapped = subjectFromSupabase({
      sub: 'u1',
      role: 'authenticated',
      user_metadata: { user_role: 'admin', roles: ['admin'] },
    });
    expect(mapped.principal?.id).toBe('u1');
    expect(mapped.principal?.roles ?? []).not.toContain('admin');
    expect(JSON.stringify(mapped)).not.toContain('admin');
  });

  it('treats a requested tenant with no membership as no tenant', async () => {
    const permdock = await createPermDock(policy, viewer, { tenant: 'o9' });
    expect(permdock.subject.principal?.tenant).toBeUndefined();
    expect(
      permdock.can(permissions.project.read, { id: 'x', orgId: 'o9' }),
    ).toBe(false);
    const member = await createPermDock(policy, viewer, { tenant: 'o1' });
    expect(member.subject.principal?.tenant).toBe('o1');
  });

  it('ignores identity in unsigned headers and request bodies', async () => {
    const { permdock: permdockFor } = createServerPermDock(policy, {
      subject: () => null,
    });
    const permdock = await permdockFor(
      new Request('https://api.example.com/projects', {
        method: 'POST',
        headers: {
          'x-user-id': 'u1',
          'x-permdock-subject': JSON.stringify(viewer),
          'x-tenant-id': 'o1',
        },
        body: JSON.stringify({ subject: viewer, tenant: 'o1' }),
      }),
    );
    expect(permdock.subject.principal).toBeNull();
    expect(
      permdock.can(permissions.project.read, { id: 'p', orgId: 'o1' }),
    ).toBe(false);
  });

  it('takes the actor a policy delegation matches only from the adapter, never from headers or bodies', async () => {
    const delegating = definePolicy(permissions, {
      scopes: { organization: { key: 'orgId' } },
      roles: [
        role('viewer', [allow(permissions.project.read)], {
          on: 'organization',
        }),
      ],
      delegations: [
        { from: 'viewer', to: 'eve', permissions: [permissions.project.read] },
      ],
      subject: (user: User | null) =>
        user === null ? null : { id: user.id, memberships: user.memberships },
    });
    const { permdock: permdockFor } = createServerPermDock(delegating, {
      subject: () => viewer,
      tenant: 'o1',
    });
    const permdock = await permdockFor(
      new Request('https://api.example.com/projects', {
        method: 'POST',
        headers: {
          'x-permdock-actor': JSON.stringify({ id: 'agent', kind: 'eve' }),
          'x-tenant-id': 'o1',
        },
        body: JSON.stringify({ actor: { id: 'agent', kind: 'eve' } }),
      }),
    );
    // No actor reached the subject, so this is a human call and the
    // delegation plays no part; an actor from a header would have made it
    // `granted` through the delegation ceiling.
    expect(permdock.subject.actor).toBeUndefined();
    const asAgent = await createPermDock(delegating, viewer, {
      actor: { id: 'agent', kind: 'eve' },
      tenant: 'o1',
    });
    const plain = permdock.snapshot();
    const delegated = asAgent.snapshot();
    if (plain instanceof Promise || delegated instanceof Promise) {
      throw new Error('unsigned snapshot expected');
    }
    expect(plain.delegated).toBeUndefined();
    expect(delegated.delegated).toEqual(['project.read']);
  });
});
