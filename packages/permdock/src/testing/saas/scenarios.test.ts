import { createLocalJWKSet, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';

import type { SaasScenario } from './index.ts';

import {
  createPermDock,
  fromSnapshot,
  memoryLimitStore,
  memoryRoleSource,
  parseSnapshot,
} from '../../index.ts';
import {
  saasCustomRoles,
  saasPermissions,
  saasPolicy,
  saasPrincipal,
  saasScenarios,
  saasSchemaSql,
  saasSeed,
  saasSeedSql,
  saasUsers,
  signSaasToken,
} from './index.ts';

async function instanceFor(user: string, tenant: string | undefined) {
  return createPermDock(saasPolicy, saasPrincipal(user, tenant), {
    ...(tenant === undefined ? {} : { tenant }),
    customRoles: memoryRoleSource(saasCustomRoles),
    limits: memoryLimitStore(),
  });
}

async function checkServer(scenario: SaasScenario): Promise<void> {
  const permdock = await instanceFor(scenario.user, scenario.tenant);
  const decision = permdock.decide(
    scenario.permission as never,
    scenario.row as never,
  );
  expect(decision.outcome).toBe(scenario.expected.outcome);
  if (scenario.expected.reason !== undefined) {
    expect(decision.denials.map((denial) => denial.reason)).toContain(
      scenario.expected.reason,
    );
  }
}

async function checkClient(scenario: SaasScenario): Promise<void> {
  const permdock = await instanceFor(scenario.user, scenario.tenant);
  const client = fromSnapshot(
    parseSnapshot(JSON.stringify(permdock.snapshot())),
  );
  const outcome = scenario.clientOutcome ?? scenario.expected.outcome;
  expect(client.can(scenario.permission as never, scenario.row as never)).toBe(
    outcome === 'granted',
  );
}

describe('saas scenarios', () => {
  for (const scenario of saasScenarios) {
    const server = `server: ${scenario.name}`;
    it(server, () => checkServer(scenario));
    if (scenario.client !== false) {
      const client = `client: ${scenario.name}`;
      it(client, () => checkClient(scenario));
    }
  }
});

describe('saas seed', () => {
  it('lists every user once, including one without memberships', () => {
    expect(new Set(saasUsers).size).toBe(saasUsers.length);
    expect(saasUsers).toContain('mallory');
  });

  it('keeps every row inside a seeded org', () => {
    const orgs = new Set(saasSeed.orgs.map((org) => org.id));
    for (const row of [...saasSeed.projects, ...saasSeed.docs]) {
      expect(orgs.has(row.orgId)).toBe(true);
    }
  });

  it('validates rows at the boundary', async () => {
    const permdock = await instanceFor('alice', 'acme');
    expect(
      permdock.decide(
        saasPermissions.project.update,
        {
          id: 'p1',
          orgId: 'acme',
        } as never,
        { trusted: false },
      ).denials,
    ).toContainEqual(expect.objectContaining({ reason: 'validation' }));
  });

  it('emits schema and seed SQL without service_role', () => {
    const sql = `${saasSchemaSql}\n${saasSeedSql()}`;
    expect(sql).not.toMatch(/service_role/iu);
    expect(sql).toContain(`('p4', 'acme', 'bob', 'Old tunnel', true)`);
    expect(saasSeedSql({ ...saasSeed, members: [], docs: [] })).not.toContain(
      'org_member',
    );
  });
});

describe('saas tokens', () => {
  it('signs an ES256 token jose verifies against the published JWKS', async () => {
    const token = await signSaasToken('alice', { now: 1_900_000_000 });
    const { payload, protectedHeader } = await jwtVerify(
      token,
      createLocalJWKSet({
        keys: [
          {
            kty: 'EC',
            crv: 'P-256',
            x: 'p5Q0wX-3-mOBqOcCTP-RHesn80ydMMNOpr_YNY6uE1I',
            y: 'Tr8Bo2w8QPJ1l0BfNLOEUsSz2VVJGx8AWMOika2yUeA',
            kid: 'e2e',
          },
        ],
      }),
      {
        issuer: 'https://saas.permdock.test',
        audience: 'permdock-saas',
        currentDate: new Date(1_900_000_100_000),
      },
    );
    expect(protectedHeader).toEqual({
      alg: 'ES256',
      kid: 'e2e',
      typ: 'at+jwt',
    });
    expect(payload.sub).toBe('alice');
    expect(payload.memberships).toEqual([
      { tenant: 'acme', roles: ['admin'] },
      { tenant: 'globex', roles: ['viewer'] },
    ]);
    const bare = await signSaasToken('bob', { memberships: false });
    expect(bare.split('.')).toHaveLength(3);
  });
});
