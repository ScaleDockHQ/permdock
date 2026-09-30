import { describe, expect, it } from 'vitest';

import type { RlsSqlContext } from '../../src/cli/rls-sql.ts';

import {
  breakGlassEntries,
  breakGlassSql,
} from '../../src/cli/rls-break-glass.ts';
import {
  breakGlass,
  definePermissions,
  definePolicy,
  deny,
  resource,
} from '../../src/index.ts';

const Doc = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value: unknown) => ({ value }),
  },
} as const;

const permissions = definePermissions({
  patient: resource(Doc, { id: 'id', actions: ['read'] }),
});

const policy = definePolicy(permissions, {
  grants: [
    deny(permissions.patient.read, {
      to: { kind: 'anyone' },
      where: { restricted: { eq: true } },
      name: 'restricted-record',
    }),
    breakGlass(permissions.patient.read, {
      overrides: ['restricted-record'],
      requires: { purpose: ['BTG'], reason: true },
    }),
  ],
  // SAFETY: SQL generation never calls the subject mapper; only the grants are read.
  subject: (user: unknown) => user as never,
});

const ctx: RlsSqlContext = {
  dialect: 'guc',
  scopes: [],
  tenantClaim: 'tenant_id',
  gucPrefix: 'app',
};

describe('break-glass RLS generation', () => {
  it('lists the resources a break-glass grant targets, with the mapped table', () => {
    expect(breakGlassEntries(policy, undefined)).toEqual([
      { resource: 'patient', table: 'patient' },
    ]);
    expect(breakGlassEntries(policy, { patient: 'patients' })).toEqual([
      { resource: 'patient', table: 'patients' },
    ]);
  });

  it('emits an audit table and a security definer read function', () => {
    const sql = breakGlassSql(
      ctx,
      breakGlassEntries(policy, { patient: 'patients' }),
    );
    expect(sql).toContain('permdock_break_glass_audit');
    expect(sql).toContain('permdock_break_glass_patient(p_permission text)');
    expect(sql).toContain('security definer');
    expect(sql).toContain('"public"."patients"');
    expect(sql).toContain("session ->> 'permission' <> p_permission");
    expect(sql).toContain("session ->> 'reason'");
    expect(sql).toContain(
      'grant execute on function "public".permdock_break_glass_patient(text) to authenticated',
    );
    expect(sql).not.toMatch(/service_role/iu);
  });

  it('is empty for a policy with no break-glass grant', () => {
    const plain = definePolicy(permissions, {
      grants: [],
      // SAFETY: SQL generation never calls the subject mapper; only the grants are read.
      subject: (user: unknown) => user as never,
    });
    expect(breakGlassSql(ctx, breakGlassEntries(plain, undefined))).toBe('');
  });
});
