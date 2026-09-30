import { describe, expect, it } from 'vitest';

import type { Subject } from '../../src/core/subject.ts';

import {
  statementText,
  subjectStatements,
} from '../../src/conditions/subject-settings.ts';

const user: { readonly subject: Subject } = {
  subject: { principal: { id: 'u1', tenant: 'o1' }, context: {} },
};

const anonymous: { readonly subject: Subject } = {
  subject: { principal: null, context: {} },
};

function texts(holder: { readonly subject: Subject }, options = {}): string[] {
  return subjectStatements(holder, options).map(statementText);
}

describe('subjectStatements', () => {
  it('sets authenticated and the JWT claims for Supabase and Neon', () => {
    for (const dialect of ['supabase', 'neon'] as const) {
      const statements = subjectStatements(user, {
        dialect,
        claims: { user_role: 'admin', sub: 'forged', role: 'service_role' },
      });
      expect(statements.map(statementText)).toEqual([
        'set local role authenticated',
        "select set_config('request.jwt.claims', $1, true)",
        "select set_config('request.jwt.claim.sub', $1, true)",
      ]);
      expect(JSON.parse(statements[1]?.values[0] ?? '')).toEqual({
        user_role: 'admin',
        sub: 'u1',
        tenant_id: 'o1',
        role: 'authenticated',
      });
    }
  });

  it('sets one setting per claim under the guc prefix', () => {
    const statements = subjectStatements(user, {
      dialect: 'guc',
      gucPrefix: 'acme',
      tenantClaim: 'org_id',
      claims: { memberships: [{ tenant: 'o1' }] },
    });
    expect(statements.map(statementText)).toEqual([
      'set local role authenticated',
      "select set_config('acme.user_id', $1, true)",
      "select set_config('acme.memberships', $1, true)",
      "select set_config('acme.org_id', $1, true)",
      "select set_config('acme.role', $1, true)",
    ]);
    expect(statements.map((statement) => statement.values[0])).toEqual([
      undefined,
      'u1',
      '[{"tenant":"o1"}]',
      'o1',
      'authenticated',
    ]);
  });

  it('uses anon without a principal and can keep the connection role', () => {
    expect(texts(anonymous)[0]).toBe('set local role anon');
    expect(texts(user, { role: false })[0]).toBe(
      "select set_config('request.jwt.claims', $1, true)",
    );
  });

  it('refuses any other role and unsafe setting names', () => {
    expect(() =>
      subjectStatements(user, { role: 'service_role' as never }),
    ).toThrow(/authenticated or anon/);
    expect(() =>
      subjectStatements(user, { dialect: 'guc', gucPrefix: "app'; drop" }),
    ).toThrow(/unsafe setting prefix/);
    expect(() =>
      subjectStatements(user, { dialect: 'guc', claims: { 'a.b': 1 } }),
    ).toThrow(/unsafe claim name/);
  });
});
