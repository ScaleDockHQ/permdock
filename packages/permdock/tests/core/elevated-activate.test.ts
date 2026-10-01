import { describe, expect, it } from 'vitest';

import type { Grant } from '../../src/core/policy.ts';
import type { Principal, Subject } from '../../src/core/subject.ts';

import {
  activate,
  breakGlass,
  evaluateBreakGlass,
  purposesOf,
} from '../../src/core/elevated.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { definePolicy, role } from '../../src/core/policy.ts';
import { defineRoles } from '../../src/core/vocabulary.ts';
import { reasonOf } from '../fixtures/decisions.ts';

const NOW = 1_800_000_000;

const permissions = definePermissions({
  doc: resource({ id: 'id', actions: ['read', 'write'] }),
  audit: resource({ id: 'id', actions: ['read'] }),
});

const roles = defineRoles({ operator: {} });

const policy = definePolicy(
  { permissions, roles },
  {
    scopes: {
      organization: { key: 'orgId' },
      project: { key: 'projectId', within: 'organization' },
    },
    roles: [
      role(roles.operator, [], {
        on: 'project',
        activation: { maxDuration: '2h' },
      }),
      role('auditor', [], {
        on: 'organization',
        activation: { assurance: { acr: ['phr'], amr: ['mfa', 'hwk'] } },
      }),
      role('owner', [], {
        on: 'organization',
        activation: { maxDuration: '1h', approval: 'human' },
      }),
      role('viewer', [], { on: 'organization' }),
    ],
    subject: () => null,
  },
);

function subject(principal: Partial<Principal> | null): Subject {
  return {
    principal: principal === null ? null : { id: 'u1', ...principal },
    context: {},
  };
}

const eligibleIn = (
  scope: string,
  id: string,
  eligible: readonly string[],
  within?: Readonly<Record<string, string>>,
) => ({
  scope,
  id,
  roles: [],
  eligible,
  ...(within === undefined ? {} : { within }),
});

describe('activate', () => {
  const operator = subject({
    memberships: [
      eligibleIn('project', 'p1', ['operator'], { organization: 'o1' }),
    ],
  });

  it.each([
    {
      name: 'an anonymous subject',
      who: subject(null),
      input: { role: 'operator', scope: 'project', id: 'p1' },
      reason: 'anonymous',
    },
    {
      name: 'a role without activation',
      who: operator,
      input: { role: 'viewer', scope: 'organization', id: 'o1' },
      reason: 'unknown-role',
    },
    {
      name: 'an undeclared role',
      who: operator,
      input: { role: 'ghost', scope: 'project', id: 'p1' },
      reason: 'unknown-role',
    },
    {
      name: 'a subject with no memberships',
      who: subject({}),
      input: { role: 'operator', scope: 'project', id: 'p1' },
      reason: 'no-membership',
    },
    {
      name: 'a within naming another organization',
      who: operator,
      input: {
        role: 'operator',
        scope: 'project',
        id: 'p1',
        within: { organization: 'o2' },
      },
      reason: 'no-membership',
    },
    {
      name: 'a within naming an undeclared scope',
      who: operator,
      input: {
        role: 'operator',
        scope: 'project',
        id: 'p1',
        within: { region: 'eu' },
      },
      reason: 'no-membership',
    },
  ])('denies $name', ({ who, input, reason }) => {
    expect(reasonOf(activate(policy, who, input, NOW))).toBe(reason);
  });

  it('accepts a role reference and caps the requested duration', () => {
    const capped = activate(
      policy,
      operator,
      {
        role: roles.operator,
        scope: 'project',
        id: 'p1',
        within: { organization: 'o1' },
        duration: '8h',
      },
      NOW,
    );
    const defaulted = activate(
      policy,
      operator,
      { role: 'operator', scope: 'project', id: 'p1' },
      NOW,
    );
    expect({
      capped: capped.outcome === 'granted' ? capped.elevation : undefined,
      defaulted:
        defaulted.outcome === 'granted'
          ? defaulted.elevation?.expiresAt
          : undefined,
    }).toEqual({
      capped: {
        scope: 'project',
        id: 'p1',
        within: { organization: 'o1' },
        roles: ['operator'],
        via: 'elevated',
        expiresAt: NOW + 7200,
        grantedBy: 'u1',
      },
      defaulted: NOW + 7200,
    });
  });

  it('asks for approval before minting an approval-gated elevation', () => {
    const decision = activate(
      policy,
      subject({ memberships: [eligibleIn('organization', 'o1', ['owner'])] }),
      { role: 'owner', scope: 'organization', id: 'o1' },
      NOW,
    );
    expect(decision.outcome).toBe('approval-required');
  });

  describe('assurance', () => {
    const auditor = (assurance?: Principal['assurance']) =>
      subject({
        memberships: [eligibleIn('organization', 'o1', ['auditor'])],
        ...(assurance === undefined ? {} : { assurance }),
      });
    const input = { role: 'auditor', scope: 'organization', id: 'o1' };

    it.each([
      { name: 'no assurance', held: undefined, outcome: 'denied' },
      { name: 'another acr', held: { acr: 'pwd' }, outcome: 'denied' },
      { name: 'the acr without amr', held: { acr: 'phr' }, outcome: 'denied' },
      {
        name: 'only some methods',
        held: { acr: 'phr', amr: ['mfa'] },
        outcome: 'denied',
      },
      {
        name: 'every method',
        held: { acr: 'phr', amr: ['hwk', 'mfa', 'pwd'] },
        outcome: 'granted',
      },
    ])('with $name: $outcome', ({ held, outcome }) => {
      const decision = activate(policy, auditor(held), input, NOW);
      expect({
        outcome: decision.outcome,
        reason: reasonOf(decision),
        expiresAt:
          decision.outcome === 'granted'
            ? decision.elevation?.expiresAt
            : undefined,
      }).toEqual({
        outcome,
        reason:
          outcome === 'denied' ? 'insufficient-user-authentication' : undefined,
        expiresAt: undefined,
      });
    });
  });
});

describe('breakGlass', () => {
  it('builds one grant per permission of a list or tree, without overrides', () => {
    const fromList = breakGlass([permissions.doc.read, permissions.doc.write]);
    // SAFETY: breakGlass returns a grant list for more than one permission; the test reads the keys.
    const list = fromList as readonly Omit<Grant, 'role' | 'scope'>[];
    expect({
      keys: list.map((grant) => grant.permission.key),
      overrides: list[0]?.breakGlass?.overrides,
    }).toEqual({ keys: ['doc.read', 'doc.write'], overrides: [] });
  });

  it('grants without a justify obligation when no reason is given', () => {
    // SAFETY: one permission yields one grant.
    const grant = breakGlass(permissions.audit.read, {
      obligations: ['notify'],
    }) as Omit<Grant, 'role' | 'scope'>;
    const spec = grant.breakGlass;
    expect(
      spec === undefined
        ? undefined
        : evaluateBreakGlass(
            spec,
            { principal: { id: 'u1' }, context: { purpose: ['incident', 7] } },
            NOW,
          ),
    ).toEqual({ kind: 'granted', obligations: [{ kind: 'notify' }] });
  });

  it.each([
    { purpose: 'incident', expected: ['incident'] },
    { purpose: '', expected: [] },
    { purpose: 7, expected: [] },
    { purpose: undefined, expected: [] },
  ])('reads purpose $purpose as $expected', ({ purpose, expected }) => {
    expect(purposesOf({ principal: null, context: { purpose } })).toEqual(
      expected,
    );
  });
});
