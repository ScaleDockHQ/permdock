import { describe, expect, it } from 'vitest';

import type { DecisionEvent } from '../../src/core/interfaces.ts';

import { accessToOcsf, toOcsf } from '../../src/core/ocsf.ts';

const base: DecisionEvent = {
  type: 'decision',
  at: '2026-09-28T10:00:00.000Z',
  outcome: 'denied',
  permission: 'post.delete',
  scope: 'post:delete',
  resource: { type: 'post', id: 'p_1' },
  subject: {
    principal: { id: 'u_1', roles: ['member'], tenant: 'acme' },
    actor: { id: 'agent_1', kind: 'agent' },
  },
  tenant: 'acme',
  denials: [
    { role: 'member', reason: 'no-grant' },
    { role: null, reason: 'condition' },
  ],
  trusted: true,
  source: 'adapter',
  adapter: 'mcp',
};

describe('toOcsf', () => {
  it('maps a denial onto Authorize Session', () => {
    expect(toOcsf(base)).toEqual({
      class_uid: 3003,
      category_uid: 3,
      activity_id: 1,
      type_uid: 300301,
      severity_id: 1,
      time: Date.parse('2026-09-28T10:00:00.000Z'),
      status_id: 2,
      status: 'Failure',
      status_detail: 'no-grant,condition',
      message: 'post.delete denied',
      privileges: ['post.delete'],
      user: { uid: 'u_1' },
      actor: { user: { uid: 'u_1' }, app_name: 'agent_1' },
      metadata: {
        version: '1.3.0',
        product: {
          name: 'PermDock',
          vendor_name: 'PermDock',
          feature: { name: 'mcp' },
        },
        tenant_uid: 'acme',
      },
      unmapped: {
        outcome: 'denied',
        scope: 'post:delete',
        resource: { type: 'post', id: 'p_1' },
        source: 'adapter',
      },
    });
  });

  it('maps granted, approval-required and anonymous events', () => {
    const granted = toOcsf({
      ...base,
      outcome: 'granted',
      denials: undefined,
      subject: { principal: null },
      matched: { role: 'admin', permission: 'post.delete' },
    });
    expect(granted.status_id).toBe(1);
    expect(granted.status_detail).toBeUndefined();
    expect(granted.user).toEqual({ name: 'anonymous' });
    expect(granted.unmapped.role).toBe('admin');
    const pending = toOcsf({
      ...base,
      outcome: 'approval-required',
      token: 'tok_1',
      phase: 'requested',
    });
    expect(pending.status_id).toBe(99);
    expect(pending.status_detail).toBe('approval-required');
    expect(pending.metadata.correlation_uid).toBe('tok_1');
    expect(JSON.parse(JSON.stringify(pending))).toEqual(pending);
  });

  it('maps an unparsable time to 0, drops an empty detail and names an anonymous actor by app only', () => {
    const event = toOcsf({
      ...base,
      at: 'not a date',
      denials: [],
      subject: { principal: null, actor: { id: 'agent_1', kind: 'agent' } },
    });
    expect(event.time).toBe(0);
    expect(event.status_detail).toBeUndefined();
    expect(event.actor).toEqual({ app_name: 'agent_1' });
  });

  it('maps an outcome it does not know to Unknown', () => {
    // SAFETY: a forged outcome, as a sink could receive from a newer producer.
    const forged = { ...base, outcome: 'maybe' } as unknown as DecisionEvent;
    const event = toOcsf(forged);
    expect({ id: event.status_id, status: event.status }).toEqual({
      id: 0,
      status: 'Unknown',
    });
  });
});

describe('accessToOcsf', () => {
  const access = {
    type: 'access',
    at: '2026-09-28T10:00:00.000Z',
    source: 'support',
    operation: 'started',
    tenant: 'acme',
    principal: { id: 'vendor_1' },
    via: 'support',
    roles: ['admin'],
  } as const;

  it('enables on start and disables on end or revoke, always high severity', () => {
    const started = accessToOcsf({
      ...access,
      actor: { id: 'owner_1', kind: 'user' },
      grantedBy: 'owner_1',
      reason: 'ticket 42',
    });
    expect(started).toMatchObject({
      class_uid: 3001,
      activity_id: 2,
      type_uid: 300102,
      severity_id: 4,
      time: Date.parse(access.at),
      user: { uid: 'vendor_1' },
      actor: { user: { uid: 'owner_1' } },
      metadata: { tenant_uid: 'acme' },
      unmapped: {
        operation: 'started',
        grantedBy: 'owner_1',
        reason: 'ticket 42',
      },
    });
    for (const operation of ['ended', 'revoked'] as const) {
      const ended = accessToOcsf({ ...access, operation, at: 'never' });
      expect({ operation, ended }).toMatchObject({
        operation,
        ended: { activity_id: 5, type_uid: 300105, time: 0 },
      });
      expect(ended.actor).toBeUndefined();
    }
  });
});
