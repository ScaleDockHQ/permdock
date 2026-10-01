import { describe, expect, it } from 'vitest';

import type { Decision } from '../../src/core/decision.ts';
import type { PermDock } from '../../src/core/permdock.ts';

import { filterCommandEntries } from '../../src/terminal/filter.ts';
import { exitCode, formatDecision } from '../../src/terminal/format.ts';
import { permissions } from '../fixtures/quick-start.ts';

const granted: Decision = {
  outcome: 'granted',
  subject: { principal: { id: 'u1', roles: [] }, context: {} },
  matched: { role: 'member', permission: 'post.read' },
  token: 'pd1.x',
};

const approval: Decision = {
  outcome: 'approval-required',
  grant: { role: 'member', permission: 'post.delete', approval: 'human' },
  reason: 'human',
  token: 'pd1.y',
};

const denied: Decision = {
  outcome: 'denied',
  denials: [{ role: null, reason: 'no-grant' }],
  alternatives: [],
};

describe('formatDecision without a permission', () => {
  it('takes the key from the matched grant', () => {
    expect(JSON.parse(formatDecision(granted, { json: true }))).toEqual({
      outcome: 'granted',
      permission: 'post.read',
    });
  });

  it('takes the key from the approval grant', () => {
    expect(
      JSON.parse(formatDecision(approval, { json: true, instance: '/run/1' })),
    ).toMatchObject({
      status: 403,
      permission: 'post.delete',
      instance: '/run/1',
    });
    expect(formatDecision(approval)).toContain('post.delete');
  });

  it('uses unknown for a denial and an anonymous subject', () => {
    expect(JSON.parse(formatDecision(denied, { json: true }))).toMatchObject({
      status: 403,
      permission: 'unknown',
    });
    expect(formatDecision(denied)).toContain('unknown');
  });

  it('maps exit codes', () => {
    expect([exitCode(granted), exitCode(approval), exitCode(denied)]).toEqual([
      0, 75, 77,
    ]);
  });
});

describe('filterCommandEntries', () => {
  const entries = [
    {
      name: 'read',
      permission: permissions.post.read,
      description: 'Read',
    },
  ];

  it('hides instance commands when the snapshot is signed or async', () => {
    for (const snapshot of ['signed.jws', Promise.resolve({ grants: [] })]) {
      // SAFETY: filterCommandEntries only calls snapshot() for an instance permission.
      const dock = { snapshot: () => snapshot } as unknown as PermDock;
      expect(filterCommandEntries(dock, entries, { mode: 'hide' })).toEqual([]);
    }
  });
});
