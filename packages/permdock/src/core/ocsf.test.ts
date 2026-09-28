import { describe, expect, it } from 'vitest';

import type { DecisionEvent } from './interfaces.ts';

import { toOcsf } from './ocsf.ts';

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
    expect(granted.user).toBeUndefined();
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
});
