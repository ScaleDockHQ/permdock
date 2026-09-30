import { describe, expect, it } from 'vitest';

import type { Credential } from '../../src/core/credential.ts';
import type { DecisionEvent } from '../../src/core/interfaces.ts';
import type { Principal, Subject } from '../../src/core/subject.ts';

import { parseCloudEvent } from '../../src/cloud/webhook.ts';
import { capabilitySubject } from '../../src/core/capability.ts';
import {
  credentialDelegation,
  credentialPolicyViolation,
  credentialSubject,
  decideCredential,
  parseCredential,
} from '../../src/core/credential.ts';
import { memorySettings } from '../../src/core/interfaces.ts';
import { createPermDock } from '../../src/core/permdock.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { allow, definePolicy, role } from '../../src/core/policy.ts';
import { credentialEvent, toCloudEvent } from '../../src/core/sink.ts';

const org = { organization: { field: 'orgId', memberOf: 'organization' } };

const permissions = definePermissions({
  repo: resource({ actions: ['read', 'write', 'delete'], relations: org }),
  billing: resource({ actions: ['read'], relations: org }),
});

const { repo, billing } = permissions;

const policy = definePolicy(
  { permissions },
  {
    subject: (user: Subject) => user,
    scopes: { organization: { key: 'orgId' } },
    roles: [
      role(
        'owner',
        [
          allow(repo.read),
          allow(repo.write),
          allow(repo.delete),
          allow(billing.read),
        ],
        { on: 'organization' },
      ),
      role('developer', [allow(repo.read), allow(repo.write)], {
        on: 'organization',
      }),
      role('reader', [allow(repo.read)], { on: 'organization' }),
    ],
  },
);

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

function dock(subject: Subject) {
  const instance = createPermDock(policy, subject);
  if (instance instanceof Promise) {
    throw new TypeError('expected a synchronous instance');
  }
  return instance;
}

function person(
  id: string,
  roles: readonly string[],
  tenant = 'o_1',
): Principal {
  return {
    id,
    kind: 'user',
    tenant,
    memberships: roles.length === 0 ? [] : [{ tenant, roles }],
  };
}

function userSubject(
  id: string,
  roles: readonly string[],
  extra: Partial<Subject> = {},
): Subject {
  return { principal: person(id, roles), context: {}, ...extra };
}

const r1 = { id: 'r_1', orgId: 'o_1' };
const r2 = { id: 'r_2', orgId: 'o_1' };
const other = { id: 'r_9', orgId: 'o_2' };

const userKey: Credential = {
  v: 1,
  id: 'key_1',
  kind: 'user',
  principal: 'u_1',
  permissions: [{ permission: 'repo.read' }],
  createdBy: 'u_1',
  createdAt: NOW,
  expiresAt: NOW + DAY,
};

const serviceKey: Credential = {
  v: 1,
  id: 'svc_1',
  kind: 'service',
  principal: 'ci',
  tenant: 'o_1',
  roles: ['developer'],
  permissions: [{ permission: 'repo.read' }, { permission: 'repo.write' }],
  createdBy: 'u_1',
  createdAt: NOW,
  expiresAt: NOW + DAY,
};

describe('parseCredential', () => {
  it('keeps the v1 fields of a user and a service credential', () => {
    expect(parseCredential({ ...userKey, extra: true })).toEqual(userKey);
    expect(parseCredential(serviceKey)).toEqual(serviceKey);
    expect(Object.isFrozen(parseCredential(userKey))).toBe(true);
  });

  it('rejects a wrong type in any known field', () => {
    const rows: readonly unknown[] = [
      null,
      [],
      { ...userKey, v: 2 },
      { ...userKey, kind: 'link' },
      { ...userKey, id: '' },
      { ...userKey, principal: 7 },
      { ...userKey, permissions: [] },
      { ...userKey, permissions: [{ permission: 'repo.read', ids: [] }] },
      { ...userKey, permissions: [{ key: 'repo.read' }] },
      { ...userKey, createdAt: Number.NaN },
      { ...userKey, expiresAt: '2027' },
      { ...userKey, name: 'x'.repeat(257) },
      { ...userKey, tenant: 'o_1' },
      { ...userKey, roles: ['owner'] },
      { ...serviceKey, tenant: undefined },
      { ...serviceKey, roles: [] },
    ];
    for (const row of rows) {
      expect(parseCredential(row)).toBeUndefined();
    }
  });

  it('never reads a field from the prototype', () => {
    const inherited = Object.create({ kind: 'user' }) as Record<
      string,
      unknown
    >;
    Object.assign(inherited, { ...userKey, kind: undefined });
    expect(parseCredential(inherited)).toBeUndefined();
    const polluted = JSON.parse(
      `{"v":1,"id":"k","kind":"user","principal":"u","createdBy":"u","createdAt":1,"permissions":[{"permission":"repo.read","__proto__":{"ids":["r_1"]}}]}`,
    ) as unknown;
    expect(parseCredential(polluted)?.permissions).toEqual([
      { permission: 'repo.read' },
    ]);
  });
});

describe('credentialPolicyViolation', () => {
  it('refuses a key without expiry unless a policy allows it and none caps it', () => {
    const forever = { ...userKey, expiresAt: undefined } as Credential;
    expect(credentialPolicyViolation(forever, [])).toBe('no-expiry');
    expect(credentialPolicyViolation(forever, {})).toBe('no-expiry');
    expect(credentialPolicyViolation(forever, { allowNoExpiry: true })).toBe(
      undefined,
    );
    expect(
      credentialPolicyViolation(forever, [
        { allowNoExpiry: true },
        { maxTtl: DAY },
      ]),
    ).toBe('no-expiry');
  });

  it('checks kinds and the lifetime from createdAt, failing closed on a bad maxTtl', () => {
    expect(credentialPolicyViolation(userKey, { kinds: ['service'] })).toBe(
      'kind',
    );
    expect(credentialPolicyViolation(userKey, { maxTtl: DAY })).toBe(undefined);
    expect(credentialPolicyViolation(userKey, { maxTtl: DAY - 1 })).toBe('ttl');
    expect(credentialPolicyViolation(userKey, { maxTtl: -1 })).toBe('ttl');
    expect(
      credentialPolicyViolation(userKey, { maxTtl: Number.POSITIVE_INFINITY }),
    ).toBe('ttl');
    expect(
      credentialPolicyViolation(userKey, [
        {},
        { kinds: ['user'] },
        { maxTtl: 1 },
      ]),
    ).toBe('ttl');
  });
});

describe('credentialSubject', () => {
  it('intersects a user key with its owner live rights', () => {
    const owner = person('u_1', ['developer']);
    const permdock = dock(credentialSubject(userKey, { permissions, owner }));
    expect(permdock.can(repo.read, r1)).toBe(true);
    const write = permdock.decide(repo.write, r1);
    expect(write.outcome).toBe('denied');
    expect(write.outcome === 'denied' && write.denials[0]?.reason).toBe(
      'not-delegated',
    );
    expect(permdock.can(repo.read, other)).toBe(false);
  });

  it('loses what the owner loses: a demoted owner reads nothing', () => {
    const demoted = person('u_1', []);
    const permdock = dock(
      credentialSubject(userKey, { permissions, owner: demoted }),
    );
    expect(permdock.can(repo.read, r1)).toBe(false);
  });

  it('limits a permission to its ids through RFC 9396 entries', () => {
    const scoped: Credential = {
      ...userKey,
      permissions: [
        { permission: 'repo.read' },
        { permission: 'repo.write', ids: ['r_1'] },
      ],
    };
    expect(credentialDelegation(scoped, permissions)).toEqual({
      scopes: ['repo:read'],
      authorizationDetails: [
        { type: 'repo', actions: ['write'], identifier: 'r_1' },
      ],
    });
    const permdock = dock(
      credentialSubject(scoped, {
        permissions,
        owner: person('u_1', ['owner']),
      }),
    );
    expect(permdock.can(repo.write, r1)).toBe(true);
    expect(permdock.can(repo.write, r2)).toBe(false);
    expect(permdock.can(repo.delete, r1)).toBe(false);
  });

  it('delegates nothing once every key is gone from the definitions', () => {
    const stale: Credential = {
      ...userKey,
      permissions: [{ permission: 'repo.archive' }],
    };
    expect(credentialDelegation(stale, permissions)).toEqual({ scopes: [] });
    const permdock = dock(
      credentialSubject(stale, {
        permissions,
        owner: person('u_1', ['owner']),
      }),
    );
    const decision = permdock.decide(repo.read, r1);
    expect(decision.outcome === 'denied' && decision.denials[0]?.reason).toBe(
      'no-delegation',
    );
  });

  it('refuses an owner who is someone else or not a user', () => {
    expect(
      credentialSubject(userKey, {
        permissions,
        owner: person('u_2', ['owner']),
      }).principal,
    ).toBeNull();
    expect(
      credentialSubject(userKey, {
        permissions,
        owner: { id: 'u_1', kind: 'service' },
      }).principal,
    ).toBeNull();
  });

  it('makes a service key a service principal holding its roles in one tenant', () => {
    const subject = credentialSubject(serviceKey, { permissions });
    expect(subject.principal).toMatchObject({
      id: 'ci',
      kind: 'service',
      tenant: 'o_1',
      memberships: [{ tenant: 'o_1', roles: ['developer'], via: 'credential' }],
    });
    expect(subject.expiresAt).toBe(serviceKey.expiresAt);
    const permdock = dock(subject);
    expect(permdock.can(repo.read, r1)).toBe(true);
    expect(permdock.can(repo.write, r1)).toBe(true);
    expect(permdock.can(repo.delete, r1)).toBe(false);
    expect(permdock.can(repo.read, other)).toBe(false);
    expect(permdock.tenant('o_2').can(repo.read, other)).toBe(false);
  });

  it('names the credential on every decision event', () => {
    const events: DecisionEvent[] = [];
    const permdock = dock(credentialSubject(serviceKey, { permissions }));
    permdock.on('decision', (event) => {
      events.push(event as DecisionEvent);
    });
    permdock.can(repo.read, r1);
    expect(events[0]?.subject.credential).toEqual({
      id: 'svc_1',
      kind: 'service',
    });
    const plain = dock(userSubject('u_1', ['owner']));
    plain.on('decision', (event) => {
      events.push(event as DecisionEvent);
    });
    plain.can(repo.read, r1);
    expect(events[1]?.subject.credential).toBeUndefined();
  });
});

describe('decideCredential', () => {
  const developer = dock(userSubject('u_1', ['developer']));
  const expiresAt = NOW + DAY;
  const readKey = {
    kind: 'user' as const,
    id: 'k',
    permissions: [repo.read],
    expiresAt,
  };

  it('creates a user key bound to its creator', async () => {
    const decision = await decideCredential(
      developer,
      {
        kind: 'user',
        id: 'key_1',
        permissions: [repo.read, { permission: repo.write, ids: ['r_1'] }],
        expiresAt,
        name: 'deploy script',
      },
      { now: NOW },
    );
    expect(decision).toEqual({
      outcome: 'granted',
      credential: {
        v: 1,
        id: 'key_1',
        kind: 'user',
        principal: 'u_1',
        permissions: [
          { permission: 'repo.read' },
          { permission: 'repo.write', ids: ['r_1'] },
        ],
        createdBy: 'u_1',
        createdAt: NOW,
        expiresAt,
        name: 'deploy script',
      },
    });
  });

  it('creates a service key within the creator ceiling', async () => {
    const decision = await decideCredential(
      developer,
      {
        kind: 'service',
        id: 'svc_1',
        principal: 'ci',
        tenant: 'o_1',
        roles: ['developer'],
        permissions: [repo.read],
        expiresAt,
      },
      { now: NOW },
    );
    expect(decision.outcome).toBe('granted');
    expect(decision.outcome === 'granted' && decision.credential).toMatchObject(
      {
        kind: 'service',
        principal: 'ci',
        tenant: 'o_1',
        roles: ['developer'],
        createdBy: 'u_1',
      },
    );
  });

  it('refuses a service key past the creator with exceeds-creator', async () => {
    const base = {
      kind: 'service' as const,
      id: 'svc_1',
      tenant: 'o_1',
      roles: ['developer'],
      permissions: [repo.read],
      expiresAt,
    };
    const rows = [
      [{ ...base, roles: ['owner'] }, { role: 'owner' }],
      [{ ...base, permissions: [repo.delete] }, { permission: 'repo.delete' }],
      [
        { ...base, permissions: [billing.read] },
        { permission: 'billing.read' },
      ],
      [{ ...base, tenant: 'o_2' }, { tenant: 'o_2' }],
    ] as const;
    for (const [request, detail] of rows) {
      expect(await decideCredential(developer, request, { now: NOW })).toEqual({
        outcome: 'denied',
        denials: [{ role: null, reason: 'exceeds-creator', detail }],
      });
    }
  });

  it('refuses anonymous creators, links and keys minting keys', async () => {
    const anonymous = dock({ principal: null, context: {} });
    expect(await decideCredential(anonymous, readKey)).toMatchObject({
      outcome: 'denied',
      denials: [{ reason: 'anonymous' }],
    });
    const link = dock(
      capabilitySubject({
        v: 1,
        id: 'lnk_1',
        holder: 'link',
        on: { resource: 'repo', id: 'r_1' },
        roles: ['reader'],
        expiresAt,
      }),
    );
    expect(await decideCredential(link, readKey)).toMatchObject({
      denials: [{ reason: 'exceeds-creator', detail: { creator: 'link' } }],
    });
    const key = dock(credentialSubject(serviceKey, { permissions }));
    expect(await decideCredential(key, readKey)).toMatchObject({
      denials: [
        { reason: 'exceeds-creator', detail: { creator: 'credential' } },
      ],
    });
  });

  it('keeps a delegated creator inside its delegation', async () => {
    const delegated = dock(
      userSubject('u_1', ['owner'], { delegation: { scopes: ['repo:read'] } }),
    );
    expect(
      (await decideCredential(delegated, readKey, { now: NOW })).outcome,
    ).toBe('granted');
    expect(
      await decideCredential(
        delegated,
        { ...readKey, permissions: [repo.write] },
        { now: NOW },
      ),
    ).toMatchObject({
      denials: [
        { reason: 'exceeds-creator', detail: { permission: 'repo.write' } },
      ],
    });
  });

  it('rejects malformed requests as validation', async () => {
    const rows = [
      { ...readKey, id: '' },
      { ...readKey, permissions: [] },
      { ...readKey, expiresAt: NOW - 1 },
      { ...readKey, permissions: [{ permission: repo.read, ids: [] }] },
      { ...readKey, permissions: [{ ...repo.read, key: 'repo.archive' }] },
      {
        kind: 'service' as const,
        id: 'k',
        tenant: 'o_1',
        roles: [],
        permissions: [repo.read],
        expiresAt,
      },
    ];
    for (const request of rows) {
      expect(
        await decideCredential(developer, request, { now: NOW }),
      ).toMatchObject({ denials: [{ reason: 'validation' }] });
    }
  });

  it('applies the credentials settings of the key tenant', async () => {
    const long = { ...readKey, expiresAt: NOW + 90 * DAY };
    const capped = memorySettings({
      o_1: { credentials: { maxTtl: 30 * DAY } },
    });
    expect(
      await decideCredential(developer, long, { now: NOW, settings: capped }),
    ).toMatchObject({
      denials: [{ reason: 'credential-policy', detail: { rule: 'ttl' } }],
    });
    const services = memorySettings({
      o_1: { credentials: { kinds: ['service'] } },
    });
    expect(
      await decideCredential(developer, long, { now: NOW, settings: services }),
    ).toMatchObject({ denials: [{ detail: { rule: 'kind' } }] });
    const elsewhere = memorySettings({ o_2: { credentials: { maxTtl: 1 } } });
    expect(
      (
        await decideCredential(developer, long, {
          now: NOW,
          settings: elsewhere,
        })
      ).outcome,
    ).toBe('granted');
    const forever = {
      kind: 'user' as const,
      id: 'k',
      permissions: [repo.read],
    };
    expect(
      await decideCredential(developer, forever, { now: NOW }),
    ).toMatchObject({
      denials: [{ reason: 'credential-policy', detail: { rule: 'no-expiry' } }],
    });
    const open = memorySettings({
      o_1: { credentials: { allowNoExpiry: true } },
    });
    expect(
      (await decideCredential(developer, forever, { now: NOW, settings: open }))
        .outcome,
    ).toBe('granted');
  });

  it('checks a service key against its own tenant, not the creator active one', async () => {
    const owner = dock({
      principal: {
        id: 'u_1',
        kind: 'user',
        tenant: 'o_1',
        memberships: [
          { tenant: 'o_1', roles: ['owner'] },
          { tenant: 'o_2', roles: ['owner'] },
        ],
      },
      context: {},
    });
    const settings = memorySettings({ o_2: { credentials: { maxTtl: 60 } } });
    expect(
      await decideCredential(
        owner,
        {
          kind: 'service',
          id: 'svc_2',
          tenant: 'o_2',
          roles: ['reader'],
          permissions: [repo.read],
          expiresAt,
        },
        { now: NOW, settings },
      ),
    ).toMatchObject({ denials: [{ reason: 'credential-policy' }] });
  });

  it('denies when the settings source throws', async () => {
    const broken = {
      settingsFor(): never {
        throw new Error('down');
      },
    };
    expect(
      await decideCredential(developer, readKey, {
        now: NOW,
        settings: broken,
      }),
    ).toMatchObject({
      denials: [
        { reason: 'credential-policy', detail: { rule: 'unavailable' } },
      ],
    });
  });

  it('asks for approval and resumes only with the matching token', async () => {
    const settings = memorySettings({
      o_1: { credentials: { approval: true } },
    });
    const pending = await decideCredential(developer, readKey, {
      now: NOW,
      settings,
    });
    expect(pending.outcome).toBe('approval-required');
    if (pending.outcome !== 'approval-required') {
      return;
    }
    expect(pending.token).toMatch(/^pd1\./u);
    const later = await decideCredential(developer, readKey, {
      now: NOW + 60,
      settings,
      approved: pending.token,
    });
    expect(later.outcome).toBe('granted');
    const widened = await decideCredential(
      developer,
      { ...readKey, permissions: [repo.read, repo.write] },
      { now: NOW, settings, approved: pending.token },
    );
    expect(widened.outcome).toBe('approval-required');
    const otherCreator = await decideCredential(
      dock(userSubject('u_2', ['developer'])),
      readKey,
      { now: NOW, settings, approved: pending.token },
    );
    expect(otherCreator.outcome).toBe('approval-required');
  });
});

describe('credential events', () => {
  it('builds a credential event and a dev.permdock.credential CloudEvent', () => {
    const event = credentialEvent({
      operation: 'used',
      credential: serviceKey,
      sample: 0.25,
      at: '2026-09-29T00:00:00.000Z',
    });
    expect(event).toEqual({
      type: 'credential',
      at: '2026-09-29T00:00:00.000Z',
      source: 'permdock',
      operation: 'used',
      credential: { id: 'svc_1', kind: 'service' },
      principal: { id: 'ci' },
      tenant: 'o_1',
      expiresAt: serviceKey.expiresAt,
      sample: 0.25,
    });
    const cloud = toCloudEvent(event);
    expect(cloud.type).toBe('dev.permdock.credential');
    expect(cloud.subject).toBe('svc_1');
    expect(parseCloudEvent(JSON.parse(JSON.stringify(cloud)))?.type).toBe(
      'dev.permdock.credential',
    );
    expect(
      parseCloudEvent({ ...cloud, data: { ...event, operation: 'minted' } }),
    ).toBeNull();
  });

  it('accepts sample only on used events and only in (0, 1]', () => {
    expect(() =>
      credentialEvent({ operation: 'created', credential: userKey, sample: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      credentialEvent({ operation: 'used', credential: userKey, sample: 0 }),
    ).toThrow(RangeError);
    expect(
      credentialEvent({ operation: 'revoked', credential: userKey }),
    ).not.toHaveProperty('sample');
  });
});
