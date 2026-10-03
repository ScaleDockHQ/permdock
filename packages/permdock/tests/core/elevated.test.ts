import { describe, expect, it } from 'vitest';

import type { AccessEvent, DecisionEvent } from '../../src/core/interfaces.ts';
import type { PermDock } from '../../src/core/permdock.ts';
import type { Principal, Subject } from '../../src/core/subject.ts';

import { breakGlass, supportAccess } from '../../src/core/elevated.ts';
import { accessToOcsf, toOcsf } from '../../src/core/ocsf.ts';
import { createPermDock } from '../../src/core/permdock.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { allow, definePolicy, deny, role } from '../../src/core/policy.ts';
import { normalizeMembership } from '../../src/core/scopes.ts';
import { accessEvent } from '../../src/core/sink.ts';

const Doc = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value: unknown) => ({ value }),
  },
} as const;

const permissions = definePermissions({
  patient: resource(Doc, {
    id: 'id',
    actions: ['read', 'write'],
    relations: { org: { field: 'org_id', memberOf: 'organization' } },
  }),
  billing: resource(Doc, { id: 'id', actions: ['read'] }),
});

const scopes = { organization: { key: 'org_id' } } as const;

function permdockFor(
  principal: Principal | null,
  context: Record<string, unknown> = {},
  options?: Parameters<typeof createPermDock>[2],
): PermDock {
  // SAFETY: a ready Subject with no async sources, so createPermDock returns the instance.
  return createPermDock(
    policy,
    { principal, context } as Subject,
    options,
  ) as PermDock;
}

const policy = definePolicy(permissions, {
  scopes,
  roles: [
    role('nurse', [allow(permissions.patient.read)], { on: 'organization' }),
    role(
      'admin',
      [allow([permissions.patient.read, permissions.patient.write])],
      {
        on: 'organization',
        activation: {
          maxDuration: '4h',
          justification: 'required',
          assurance: { maxAge: 300 },
        },
      },
    ),
    supportAccess({
      role: 'support',
      actorRequired: true,
      consent: { by: 'owner', durations: ['1d', '7d'] },
      forbid: [permissions.billing],
    }),
  ],
  grants: [
    allow(permissions.patient.read, {
      to: { kind: 'role', role: 'support', scope: 'organization' },
    }),
    deny(permissions.patient.read, {
      to: { kind: 'anyone' },
      where: { restricted: { eq: true } },
      name: 'restricted-record',
    }),
    breakGlass(permissions.patient.read, {
      overrides: ['restricted-record'],
      requires: { purpose: ['BTG', 'ETREAT'], reason: true },
      maxDuration: '1h',
      obligations: ['notify', 'review'],
    }),
  ],
  subject: (user: Subject | null) => (user === null ? null : user.principal),
});

const nurse: Principal = {
  id: 'u1',
  memberships: [{ scope: 'organization', id: 'T', roles: ['nurse'] }],
};

describe('membership primitive', () => {
  it('round-trips grantedBy, reason, eligible and member.group', () => {
    const membership = normalizeMembership(
      {
        scope: 'organization',
        id: 'T',
        roles: ['admin'],
        via: 'elevated',
        grantedBy: 'admin-1',
        reason: 'incident 42',
        eligible: ['admin'],
        member: { group: 'vendor-support' },
      },
      [{ name: 'organization', key: 'org_id' }],
    );
    expect(membership).toMatchObject({
      grantedBy: 'admin-1',
      reason: 'incident 42',
      eligible: ['admin'],
      member: { group: 'vendor-support' },
    });
  });
});

describe('E1 role activation', () => {
  const eligible: Principal = {
    id: 'u2',
    assurance: { authTime: Math.floor(Date.now() / 1000) },
    memberships: [
      {
        scope: 'organization',
        id: 'T',
        roles: ['nurse'],
        eligible: ['admin'],
      },
    ],
  };

  it('grants and carries the elevated membership to write', () => {
    const permdock = permdockFor(eligible);
    const decision = permdock.activate({
      role: 'admin',
      scope: 'organization',
      id: 'T',
      duration: '2h',
      reason: 'covering shift',
    });
    expect(decision.outcome).toBe('granted');
    if (decision.outcome !== 'granted') return;
    expect(decision.elevation).toMatchObject({
      scope: 'organization',
      id: 'T',
      roles: ['admin'],
      via: 'elevated',
      grantedBy: 'u2',
      reason: 'covering shift',
    });
    expect(decision.elevation?.expiresAt).toBeGreaterThan(
      Math.floor(Date.now() / 1000),
    );
  });

  it('denies without a justification when justification is required', () => {
    const permdock = permdockFor(eligible);
    const decision = permdock.activate({
      role: 'admin',
      scope: 'organization',
      id: 'T',
      duration: '2h',
    });
    expect(decision.outcome).toBe('denied');
    if (decision.outcome === 'denied') {
      expect(decision.denials[0]?.reason).toBe('reason-required');
    }
  });

  it('denies an ineligible subject', () => {
    const permdock = permdockFor(nurse);
    const decision = permdock.activate({
      role: 'admin',
      scope: 'organization',
      id: 'T',
      reason: 'x',
    });
    expect(decision.outcome).toBe('denied');
  });

  it('denies when authentication is not fresh enough', () => {
    const stale: Principal = {
      id: 'u3',
      assurance: { authTime: Math.floor(Date.now() / 1000) - 10_000 },
      memberships: [
        {
          scope: 'organization',
          id: 'T',
          roles: ['nurse'],
          eligible: ['admin'],
        },
      ],
    };
    const permdock = permdockFor(stale);
    const decision = permdock.activate({
      role: 'admin',
      scope: 'organization',
      id: 'T',
      reason: 'x',
    });
    expect(decision.outcome).toBe('denied');
    if (decision.outcome === 'denied') {
      expect(decision.denials[0]?.reason).toBe(
        'insufficient-user-authentication',
      );
    }
  });

  it('is never held directly: activation roles are eligible-only', () => {
    const permdock = permdockFor(eligible);
    expect(
      permdock.can(permissions.patient.write, { id: 'p1', org_id: 'T' }),
    ).toBe(false);
  });
});

describe('E2 break-glass', () => {
  it('overrides the named deny with a purpose and a reason', () => {
    const permdock = permdockFor(nurse, {
      purpose: ['BTG'],
      reason: 'cardiac arrest',
    });
    const decision = permdock.decide(permissions.patient.read, {
      id: 'p1',
      org_id: 'T',
      restricted: true,
    });
    expect(decision.outcome).toBe('granted');
    if (decision.outcome !== 'granted') return;
    expect(decision.matched.breakGlass).toBe(true);
    expect(decision.obligations).toEqual([
      { kind: 'notify' },
      { kind: 'review' },
      { kind: 'justify', reason: 'cardiac arrest' },
    ]);
  });

  it('denies a restricted read without break-glass (deny-overrides-allow)', () => {
    const permdock = permdockFor(nurse);
    const decision = permdock.decide(permissions.patient.read, {
      id: 'p1',
      org_id: 'T',
      restricted: true,
    });
    expect(decision.outcome).toBe('denied');
    if (decision.outcome === 'denied') {
      expect(decision.denials[0]?.reason).toBe('deny');
    }
  });

  it('denies an unlisted purpose', () => {
    const permdock = permdockFor(nurse, {
      purpose: ['MARKETING'],
      reason: 'x',
    });
    const decision = permdock.decide(permissions.patient.read, {
      id: 'p1',
      org_id: 'T',
      restricted: true,
    });
    expect(decision.outcome).toBe('denied');
    if (decision.outcome === 'denied') {
      expect(decision.denials[0]?.reason).toBe('purpose');
    }
  });

  it('denies break-glass without a reason', () => {
    const permdock = permdockFor(nurse, { purpose: ['BTG'] });
    const decision = permdock.decide(permissions.patient.read, {
      id: 'p1',
      org_id: 'T',
      restricted: true,
    });
    expect(decision.outcome).toBe('denied');
    if (decision.outcome === 'denied') {
      expect(decision.denials[0]?.reason).toBe('reason-required');
    }
  });

  it('maps a break-glass decision to high OCSF severity', () => {
    const event: DecisionEvent = {
      type: 'decision',
      at: new Date().toISOString(),
      outcome: 'granted',
      permission: 'patient.read',
      scope: 'patient:read',
      resource: { type: 'patient', id: 'p1' },
      subject: { principal: { id: 'u1', roles: ['nurse'] } },
      matched: { role: null, permission: 'patient.read', breakGlass: true },
      purpose: ['BTG'],
      reason: 'cardiac arrest',
      trusted: true,
      source: 'decide',
    };
    const ocsf = toOcsf(event);
    expect(ocsf.severity_id).toBe(4);
    expect(ocsf.unmapped.breakGlass).toBe(true);
    expect(ocsf.unmapped.reason).toBe('cardiac arrest');
  });
});

describe('E3 support access', () => {
  const support: Principal = {
    id: 'agent',
    memberships: [
      {
        scope: 'organization',
        id: 'T',
        roles: ['support'],
        via: 'support',
        member: { group: 'vendor-support' },
      },
    ],
  };

  it('denies every decision under a support membership without an actor', () => {
    const permdock = permdockFor(support);
    const decision = permdock.decide(permissions.patient.read, {
      id: 'p1',
      org_id: 'T',
    });
    expect(decision.outcome).toBe('denied');
    if (decision.outcome === 'denied') {
      expect(decision.denials[0]?.reason).toBe('actor-required');
    }
  });

  it('grants under support with an actor and forbids the forbidden permission', () => {
    const instance = permdockFor(
      support,
      {},
      {
        actor: { id: 'op1', kind: 'support' },
        tenant: 'T',
        delegation: { scopes: ['patient:read', 'billing:read'] },
      },
    );
    expect(
      instance.can(permissions.patient.read, { id: 'p1', org_id: 'T' }),
    ).toBe(true);
    expect(instance.can(permissions.billing.read, { id: 'b1' })).toBe(false);
  });

  it('does not forbid the same permission for a non-support subject', () => {
    const owner: Principal = {
      id: 'owner1',
      memberships: [{ scope: 'organization', id: 'T', roles: ['nurse'] }],
    };
    const permdock = permdockFor(owner);
    // billing has no allow, so this is no-grant, never a support forbid.
    const decision = permdock.decide(permissions.billing.read, { id: 'b1' });
    expect(decision.outcome).toBe('denied');
    if (decision.outcome === 'denied') {
      expect(decision.denials.every((d) => d.reason !== 'actor-required')).toBe(
        true,
      );
    }
  });

  it('emits access lifecycle CloudEvents and maps them to OCSF', () => {
    const started: AccessEvent = accessEvent({
      source: 'app',
      operation: 'started',
      tenant: 'T',
      principal: { id: 'agent' },
      roles: ['support'],
      member: { group: 'vendor-support' },
      grantedBy: 'owner1',
      reason: 'ticket 9',
    });
    expect(started.type).toBe('access');
    expect(started.via).toBe('support');
    const ocsf = accessToOcsf(started);
    expect(ocsf.class_uid).toBe(3001);
    expect(ocsf.severity_id).toBe(4);
    expect(ocsf.unmapped.operation).toBe('started');
  });
});

describe('purpose of use', () => {
  const purposePermissions = definePermissions({
    note: resource(Doc, { id: 'id', actions: ['read'] }),
  });
  const purposePolicy = definePolicy(purposePermissions, {
    grants: [
      allow(purposePermissions.note.read, {
        to: { kind: 'authenticated' },
        purpose: ['treatment'],
      }),
    ],
    subject: (user: Principal | null) => user,
  });

  it('applies only when context.purpose overlaps', () => {
    // SAFETY: a ready Subject with no async sources, so createPermDock returns the instance.
    const instance = createPermDock(purposePolicy, {
      principal: { id: 'u1' },
      context: { purpose: ['treatment'] },
    }) as PermDock;
    expect(instance.can(purposePermissions.note.read, { id: 'n1' })).toBe(true);
    // SAFETY: a ready Subject with no async sources, so createPermDock returns the instance.
    const none = createPermDock(purposePolicy, {
      principal: { id: 'u1' },
      context: {},
    }) as PermDock;
    expect(none.can(purposePermissions.note.read, { id: 'n1' })).toBe(false);
  });
});

describe('activate binds a nested elevation to the eligible membership', () => {
  const tree = definePermissions({
    project: resource(Doc, {
      id: 'id',
      collection: ['create'],
      relations: { team: { field: 'team_id', memberOf: 'team' } },
    }),
  });
  const nested = (approval: boolean) =>
    definePolicy(tree, {
      scopes: {
        org: { key: 'org_id' },
        team: { key: 'team_id', within: 'org' },
      },
      roles: [
        role('team-admin', [allow(tree.project.create)], {
          on: 'team',
          activation: approval
            ? { maxDuration: '1h', approval: 'human' }
            : { maxDuration: '1h' },
        }),
      ],
      subject: (user: { readonly principal: Principal } | null) =>
        user === null ? null : user.principal,
    });
  const principal: Principal = {
    id: 'u_1',
    tenant: 'A',
    memberships: [
      {
        scope: 'team',
        id: 'eng',
        within: { org: 'A' },
        roles: [],
        eligible: ['team-admin'],
      },
    ],
  };

  it('refuses a within that differs from the eligible membership', async () => {
    const permdock = await createPermDock(nested(false), {
      principal,
      context: {},
    });
    const forged = permdock.activate({
      role: 'team-admin',
      scope: 'team',
      id: 'eng',
      within: { org: 'B' },
    });
    expect(forged.outcome).toBe('denied');
    if (forged.outcome === 'denied') {
      expect(forged.denials[0]?.reason).toBe('no-membership');
    }
  });

  it('mints the eligible membership ancestors when within is omitted', async () => {
    const permdock = await createPermDock(nested(false), {
      principal,
      context: {},
    });
    const decision = permdock.activate({
      role: 'team-admin',
      scope: 'team',
      id: 'eng',
    });
    expect(decision.outcome).toBe('granted');
    if (decision.outcome === 'granted') {
      expect(decision.elevation?.within).toEqual({ org: 'A' });
    }
  });

  it('binds the approval token to the ancestors', async () => {
    const root = await createPermDock(nested(true), {
      principal,
      context: {},
    });
    const other = await createPermDock(nested(true), {
      principal: {
        ...principal,
        memberships: [
          { scope: 'org', id: 'A', roles: [] },
          {
            scope: 'team',
            id: 'eng',
            within: { org: 'C' },
            roles: [],
            eligible: ['team-admin'],
          },
        ],
      },
      context: {},
    });
    const a = root.activate({ role: 'team-admin', scope: 'team', id: 'eng' });
    const c = other.activate({ role: 'team-admin', scope: 'team', id: 'eng' });
    expect(a.outcome).toBe('approval-required');
    expect(c.outcome).toBe('approval-required');
    if (
      a.outcome === 'approval-required' &&
      c.outcome === 'approval-required'
    ) {
      expect(a.token).not.toBe(c.token);
    }
  });
});
