import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { Decision } from '../../src/core/decision.ts';
import type { DecisionProvider } from '../../src/core/interfaces.ts';

import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockValidationError,
} from '../../src/core/errors.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { allow, definePolicy, deny, role } from '../../src/core/policy.ts';
import { createPermDock } from '../../src/pdp/index.ts';
import { reasonOf } from '../fixtures/decisions.ts';

const permissions = definePermissions({
  post: resource(z.object({ id: z.string(), title: z.string() }), {
    id: 'id',
    actions: ['read', 'update', 'delete'],
  }),
  note: resource(z.object({ key: z.string() }), {
    id: 'key',
    actions: ['read'],
  }),
});

type User = {
  readonly id: string;
  readonly roles: readonly string[];
  readonly memberships?: readonly {
    readonly tenant: string;
    readonly roles: readonly string[];
  }[];
};

const member: User = { id: 'u1', roles: ['member'] };
const post = { id: 'p1', title: 'Hello' };

function grantedBy(name: string): Decision {
  return {
    outcome: 'granted',
    subject: {
      principal: { id: 'u1', roles: ['member'] },
      context: {},
    },
    matched: { role: name, permission: 'post.read', provider: name },
    token: 'pd1.test',
  };
}

function deniedBy(reason: 'pdp-denied' | 'pdp-unavailable'): Decision {
  return {
    outcome: 'denied',
    denials: [{ role: null, reason }],
    alternatives: [],
  };
}

function provider(
  overrides: Partial<DecisionProvider> & Pick<DecisionProvider, 'decide'>,
): DecisionProvider {
  return {
    name: 'fake',
    handles: () => true,
    ...overrides,
  };
}

function policyWith(
  providers: readonly DecisionProvider[],
  onDenied?: (decision: unknown) => void,
) {
  return definePolicy(permissions, {
    roles: [
      role('member', [
        allow(permissions.post.read),
        allow(permissions.post.update),
        deny(permissions.post.delete),
        allow(permissions.note.read),
      ]),
    ],
    subject: (user: User) => user,
    providers,
    ...(onDenied === undefined ? {} : { onDenied }),
  });
}

describe('permdock/pdp createPermDock', () => {
  it('returns the local decision for permissions no provider handles', async () => {
    const decide = vi.fn<DecisionProvider['decide']>(async () =>
      grantedBy('fake'),
    );
    const permdock = await createPermDock(
      policyWith([provider({ handles: () => false, decide })]),
      member,
    );
    const decision = await permdock.decide(permissions.post.read, post);
    expect({
      outcome: decision.outcome,
      calls: decide.mock.calls.length,
    }).toEqual({ outcome: 'granted', calls: 0 });
  });

  it('keeps a policy with an empty provider list fully local', async () => {
    const permdock = await createPermDock(policyWith([]), member);
    expect(await permdock.can(permissions.post.read, post)).toBe(true);
    expect(await permdock.can(permissions.post.delete, post)).toBe(false);
  });

  it('short-circuits an anonymous subject without asking the provider', async () => {
    const decide = vi.fn<DecisionProvider['decide']>(async () =>
      grantedBy('fake'),
    );
    const permdock = await createPermDock(
      policyWith([provider({ decide })]),
      null,
    );
    const decision = await permdock.decide(permissions.post.read, post);
    expect({
      reason: reasonOf(decision),
      calls: decide.mock.calls.length,
    }).toEqual({ reason: 'anonymous', calls: 0 });
  });

  it('short-circuits a local validation failure without asking the provider', async () => {
    const decide = vi.fn<DecisionProvider['decide']>(async () =>
      grantedBy('fake'),
    );
    const permdock = await createPermDock(
      policyWith([provider({ decide })]),
      member,
    );
    const decision = await permdock.decide(permissions.post.read, { id: 1 });
    expect({
      reason: reasonOf(decision),
      calls: decide.mock.calls.length,
    }).toEqual({ reason: 'validation', calls: 0 });
  });

  it('passes the local decision, row and subject to the provider', async () => {
    const decide = vi.fn<DecisionProvider['decide']>(async () =>
      grantedBy('fake'),
    );
    const permdock = await createPermDock(
      policyWith([provider({ decide })]),
      member,
    );
    await permdock.decide(permissions.post.read, post);
    const request = decide.mock.calls[0]?.[0];
    expect({
      permission: request?.permission.key,
      data: request?.data,
      principal: request?.subject.principal?.id,
      local: request?.local.outcome,
    }).toEqual({
      permission: 'post.read',
      data: post,
      principal: 'u1',
      local: 'granted',
    });
  });

  it('denies with pdp-unavailable when a provider throws', async () => {
    const permdock = await createPermDock(
      policyWith([
        provider({
          decide: () => {
            throw new Error('boom');
          },
        }),
      ]),
      member,
    );
    expect(reasonOf(await permdock.decide(permissions.post.read, post))).toBe(
      'pdp-unavailable',
    );
    expect(await permdock.can(permissions.post.read, post)).toBe(false);
  });

  it('denies with pdp-unavailable when a provider rejects', async () => {
    const permdock = await createPermDock(
      policyWith([
        provider({ decide: () => Promise.reject(new Error('boom')) }),
      ]),
      member,
    );
    expect(reasonOf(await permdock.decide(permissions.post.read, post))).toBe(
      'pdp-unavailable',
    );
  });

  describe('assert', () => {
    it('returns a granted decision', async () => {
      const permdock = await createPermDock(
        policyWith([provider({ decide: async () => grantedBy('fake') })]),
        member,
      );
      const decision = await permdock.assert(permissions.post.read, post);
      expect(decision.outcome).toBe('granted');
    });

    it('throws PermDockDeniedError with the resource id and calls policy onDenied', async () => {
      const onDenied = vi.fn<(decision: unknown) => void>();
      const permdock = await createPermDock(
        policyWith(
          [provider({ decide: async () => deniedBy('pdp-denied') })],
          onDenied,
        ),
        member,
      );
      const error = await permdock
        .assert(permissions.post.read, post)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PermDockDeniedError);
      expect(
        error instanceof PermDockDeniedError
          ? { permission: error.permission, resource: error.resource }
          : null,
      ).toEqual({
        permission: 'post.read',
        resource: { type: 'post', id: 'p1' },
      });
      expect(onDenied.mock.calls.length).toBe(1);
    });

    it('prefers the per-call onDenied over the policy one', async () => {
      const fromPolicy = vi.fn<(decision: unknown) => void>();
      const fromCall = vi.fn<(decision: unknown) => void>();
      const permdock = await createPermDock(
        policyWith(
          [provider({ decide: async () => deniedBy('pdp-denied') })],
          fromPolicy,
        ),
        member,
      );
      await expect(
        permdock.assert(permissions.post.read, post, { onDenied: fromCall }),
      ).rejects.toBeInstanceOf(PermDockDeniedError);
      expect({
        policy: fromPolicy.mock.calls.length,
        call: fromCall.mock.calls.length,
      }).toEqual({ policy: 0, call: 1 });
    });

    it('omits the resource id when the data is not an object', async () => {
      const permdock = await createPermDock(
        policyWith([provider({ decide: async () => deniedBy('pdp-denied') })]),
        member,
      );
      const error = await permdock
        .assert(permissions.post.read)
        .catch((caught: unknown) => caught);
      expect(
        error instanceof PermDockDeniedError ? error.resource : null,
      ).toEqual({ type: 'post' });
    });

    it('reads the resource id from the declared id field', async () => {
      const permdock = await createPermDock(
        policyWith([provider({ decide: async () => deniedBy('pdp-denied') })]),
        member,
      );
      const error = await permdock
        .assert(permissions.note.read, { key: 'n1' })
        .catch((caught: unknown) => caught);
      expect(
        error instanceof PermDockDeniedError ? error.resource : null,
      ).toEqual({ type: 'note', id: 'n1' });
    });

    it('throws PermDockApprovalRequiredError for approval-required', async () => {
      const permdock = await createPermDock(
        policyWith([
          provider({
            decide: async () => ({
              outcome: 'approval-required',
              grant: {
                role: 'pdp',
                permission: 'post.read',
                provider: 'pdp',
                approval: 'human',
              },
              reason: 'human',
              token: 'pd1.remote',
            }),
          }),
        ]),
        member,
      );
      await expect(
        permdock.assert(permissions.post.read, post),
      ).rejects.toBeInstanceOf(PermDockApprovalRequiredError);
    });

    it('rethrows the validation error for invalid data', async () => {
      const permdock = await createPermDock(
        policyWith([provider({ decide: async () => grantedBy('fake') })]),
        member,
      );
      await expect(
        permdock.assert(permissions.post.read, { id: 1 }),
      ).rejects.toBeInstanceOf(PermDockValidationError);
    });

    it('throws PermDockDeniedError for a validation denial without an error detail', async () => {
      const permdock = await createPermDock(
        policyWith([
          provider({
            decide: async () => ({
              outcome: 'denied',
              denials: [{ role: null, reason: 'validation' }],
              alternatives: [],
            }),
          }),
        ]),
        member,
      );
      await expect(
        permdock.assert(permissions.post.read, post),
      ).rejects.toBeInstanceOf(PermDockDeniedError);
    });
  });

  describe('simulate', () => {
    it('decides each pair through the provider', async () => {
      const permdock = await createPermDock(
        policyWith([
          provider({
            decide: async (request) =>
              request.permission.key === 'post.read'
                ? grantedBy('fake')
                : deniedBy('pdp-denied'),
          }),
        ]),
        member,
      );
      const decisions = await permdock.simulate([
        [permissions.post.read, post],
        [permissions.post.update, post],
        [permissions.post.delete, post],
      ]);
      expect(decisions.map((decision) => reasonOf(decision))).toEqual([
        undefined,
        'pdp-denied',
        'deny',
      ]);
    });

    it('returns a PDP instance for a role preview', async () => {
      const decide = vi.fn<DecisionProvider['decide']>(async () =>
        grantedBy('fake'),
      );
      const permdock = await createPermDock(
        policyWith([provider({ decide })]),
        {
          id: 'u1',
          roles: [],
        },
      );
      const preview = permdock.simulate({ roles: ['member'] });
      expect(await preview.can(permissions.post.read, post)).toBe(true);
      expect(await preview.can(permissions.post.delete, post)).toBe(false);
      expect(
        decide.mock.calls.map(([request]) => [
          request.permission.key,
          request.local.outcome,
        ]),
      ).toEqual([['post.read', 'granted']]);
    });

    it('delegates an Arazzo plan to the local instance', async () => {
      const permdock = await createPermDock(policyWith([]), member);
      const plan = permdock.simulate({ arazzo: {}, openapi: {} });
      expect(plan instanceof Promise).toBe(false);
    });
  });

  describe('filter', () => {
    const rows = [
      { id: 'p1', title: 'a' },
      { id: 'p2', title: 'b' },
      { id: 'p3', title: 'c' },
    ];

    it('decides row by row when the provider cannot list', async () => {
      const permdock = await createPermDock(
        policyWith([
          provider({
            decide: async (request) =>
              // SAFETY: the rows above are the only data filter passes.
              (request.data as { readonly id: string }).id === 'p2'
                ? deniedBy('pdp-denied')
                : grantedBy('fake'),
          }),
        ]),
        member,
      );
      expect(
        (await permdock.filter(permissions.post.read, rows)).map(
          (row) => row.id,
        ),
      ).toEqual(['p1', 'p3']);
    });

    it('decides row by row for an anonymous subject without listing', async () => {
      const permitted = vi.fn<NonNullable<DecisionProvider['permitted']>>(
        async () => ['p1'],
      );
      const permdock = await createPermDock(
        policyWith([
          provider({ decide: async () => grantedBy('fake'), permitted }),
        ]),
        null,
      );
      expect(await permdock.filter(permissions.post.read, rows)).toEqual([]);
      expect(permitted.mock.calls.length).toBe(0);
    });

    it('denies every row when the listing fails or throws', async () => {
      for (const permitted of [
        async () => null,
        async () => {
          throw new Error('boom');
        },
      ]) {
        const permdock = await createPermDock(
          policyWith([
            provider({ decide: async () => grantedBy('fake'), permitted }),
          ]),
          member,
        );
        expect(await permdock.filter(permissions.post.read, rows)).toEqual([]);
      }
    });

    it('keeps listed rows unless local evaluation short-circuits them', async () => {
      const permdock = await createPermDock(
        policyWith([
          provider({
            decide: async () => grantedBy('fake'),
            permitted: async () => ['p1', 'p3'],
          }),
        ]),
        member,
      );
      expect(
        (await permdock.filter(permissions.post.read, rows)).map(
          (row) => row.id,
        ),
      ).toEqual(['p1', 'p3']);
      expect(await permdock.filter(permissions.post.delete, rows)).toEqual([]);
    });
  });

  describe('where', () => {
    it('returns the local where for a permission no provider handles', async () => {
      const permdock = await createPermDock(
        policyWith([
          provider({
            handles: () => false,
            decide: async () => grantedBy('x'),
          }),
        ]),
        member,
      );
      expect((await permdock.where(permissions.post.read)).partial).toBe(false);
    });

    it('returns an always-false complete result for an empty, failed or thrown listing', async () => {
      for (const permitted of [
        async () => [],
        async () => null,
        async () => {
          throw new Error('boom');
        },
      ]) {
        const permdock = await createPermDock(
          policyWith([
            provider({ decide: async () => grantedBy('fake'), permitted }),
          ]),
          member,
        );
        expect(await permdock.where(permissions.post.read)).toEqual({
          condition: { op: 'or', conditions: [] },
          partial: false,
        });
      }
    });

    it('returns an always-false partial result for an anonymous subject', async () => {
      const permdock = await createPermDock(
        policyWith([
          provider({
            decide: async () => grantedBy('fake'),
            permitted: async () => ['p1'],
          }),
        ]),
        null,
      );
      expect(await permdock.where(permissions.post.read)).toEqual({
        condition: { op: 'or', conditions: [] },
        partial: true,
      });
    });

    it('is the remote id list alone and partial when no local grant exists', async () => {
      const permdock = await createPermDock(
        policyWith([
          provider({
            decide: async () => grantedBy('fake'),
            permitted: async () => ['n1'],
          }),
        ]),
        { id: 'u1', roles: [] },
      );
      expect(await permdock.where(permissions.note.read)).toEqual({
        condition: { op: 'in', field: 'key', value: ['n1'] },
        partial: true,
      });
    });
  });

  describe('scoped instances', () => {
    it('keeps the provider on tenant and team instances', async () => {
      const decide = vi.fn<DecisionProvider['decide']>(async () =>
        deniedBy('pdp-denied'),
      );
      const permdock = await createPermDock(
        policyWith([provider({ decide })]),
        {
          id: 'u1',
          roles: [],
          memberships: [{ tenant: 'acme', roles: ['member'] }],
        },
      );
      const tenant = permdock.tenant('acme');
      expect(reasonOf(await tenant.decide(permissions.post.read, post))).toBe(
        'pdp-denied',
      );
      const team = permdock.team('t1');
      expect(await team.can(permissions.post.read, post)).toBe(false);
      expect(tenant.subject.principal?.tenant).toBe('acme');
    });
  });
});
