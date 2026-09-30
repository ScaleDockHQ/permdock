import { describe, expect, it } from 'vitest';

import type { DecisionEvent } from '../../src/core/interfaces.ts';

import { CSV_COLUMNS, toCsvRow } from '../../src/core/csv.ts';

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
  matched: { role: 'member', permission: 'post.delete' },
  via: 'membership:acme',
  denials: [
    { role: 'member', reason: 'no-grant' },
    { role: null, reason: 'condition' },
  ],
  token: 'tok_1',
  trusted: true,
  source: 'adapter',
};

describe('toCsvRow', () => {
  it('pins the column order', () => {
    expect(CSV_COLUMNS.join(',')).toBe(
      'time,principal,actor,tenant,permission,outcome,matched.role,via,denials.reason,token',
    );
  });

  it('writes one row in column order with reasons joined by ;', () => {
    expect(toCsvRow(base)).toBe(
      '2026-09-28T10:00:00.000Z,u_1,agent_1,acme,post.delete,denied,member,membership:acme,no-grant;condition,tok_1',
    );
  });

  it('leaves absent values empty', () => {
    expect(
      toCsvRow({
        ...base,
        outcome: 'granted',
        subject: { principal: null },
        tenant: undefined,
        matched: undefined,
        via: null,
        denials: undefined,
        token: undefined,
      }),
    ).toBe('2026-09-28T10:00:00.000Z,,,,post.delete,granted,,,,');
  });

  it('quotes per RFC 4180', () => {
    const row = toCsvRow({
      ...base,
      subject: { principal: { id: 'a,"b"\nc', roles: [] } },
    });
    expect(row.split(',')[1]).toBe('"a');
    expect(row).toContain('"a,""b""\nc"');
  });
});
