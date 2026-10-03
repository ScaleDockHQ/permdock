import { describe, expect, it } from 'vitest';

import type { RlsSqlContext } from '../../src/cli/rls-sql.ts';

import {
  breakGlassEntries,
  breakGlassSql,
} from '../../src/cli/rls-break-glass.ts';
import { compileGrants } from '../../src/cli/rls-compile.ts';
import { scopeList } from '../../src/core/scopes.ts';
import {
  breakGlass,
  definePermissions,
  definePolicy,
  deny,
  resource,
  role,
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
      {
        resource: 'patient',
        table: 'patient',
        grants: [
          { permission: 'patient.read', scope: 'anyone', column: undefined },
        ],
      },
    ]);
    expect(breakGlassEntries(policy, { patient: 'patients' })).toEqual([
      {
        resource: 'patient',
        table: 'patients',
        grants: [
          { permission: 'patient.read', scope: 'anyone', column: undefined },
        ],
      },
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
      'grant execute on function "permdock".permdock_break_glass_patient(text) to authenticated',
    );
    expect(sql).not.toMatch(/service_role/iu);
  });

  it('lists a resource once and keeps a schema-qualified table', () => {
    const twice = definePolicy(permissions, {
      grants: [
        ...policy.grants,
        breakGlass(permissions.patient.read, {
          overrides: ['restricted-record'],
          requires: { reason: true },
        }),
      ],
      // SAFETY: SQL generation never calls the subject mapper; only the grants are read.
      subject: (user: unknown) => user as never,
    });
    const entries = breakGlassEntries(twice, { patient: 'clinic.patients' });
    expect(entries).toEqual([
      {
        resource: 'patient',
        table: 'clinic.patients',
        grants: [
          { permission: 'patient.read', scope: 'anyone', column: undefined },
          { permission: 'patient.read', scope: 'anyone', column: undefined },
        ],
      },
    ]);
    expect(breakGlassSql(ctx, entries)).toContain('"clinic"."patients"');
  });

  it('refuses a resource name that is not a plain identifier', () => {
    expect(() =>
      breakGlassSql(ctx, [
        { resource: 'Patient-Record', table: 'patients', grants: [] },
      ]),
    ).toThrow(/unsafe break-glass resource 'Patient-Record'/u);
  });

  it('is empty for a policy with no break-glass grant', () => {
    const plain = definePolicy(permissions, {
      grants: [],
      // SAFETY: SQL generation never calls the subject mapper; only the grants are read.
      subject: (user: unknown) => user as never,
    });
    expect(breakGlassSql(ctx, breakGlassEntries(plain, undefined))).toBe('');
  });

  it('reads only the rows of instances where a role holds the break-glass grant', () => {
    const Record = {
      '~standard': Doc['~standard'],
    } as const;
    const scoped = definePermissions({
      chart: resource(Record, {
        id: 'id',
        actions: ['read'],
        relations: {
          organization: { field: 'organization_id', memberOf: 'organization' },
        },
      }),
    });
    const tenanted = definePolicy(scoped, {
      scopes: { organization: { key: 'organization_id' } },
      roles: [
        role(
          'doctor',
          [
            breakGlass(scoped.chart.read, {
              overrides: ['restricted-chart'],
              requires: { reason: true },
            }),
          ],
          { on: 'organization' },
        ),
      ],
      grants: [
        deny(scoped.chart.read, {
          to: { kind: 'anyone' },
          where: { restricted: { eq: true } },
          name: 'restricted-chart',
        }),
        breakGlass(scoped.chart.read, { overrides: ['restricted-chart'] }),
      ],
      // SAFETY: SQL generation never calls the subject mapper; only the grants are read.
      subject: (user: unknown) => user as never,
    });
    const scopedCtx: RlsSqlContext = {
      ...ctx,
      dialect: 'supabase',
      scopes: scopeList(tenanted.scopes),
    };
    const sql = breakGlassSql(
      scopedCtx,
      breakGlassEntries(tenanted, undefined),
    );
    expect(sql).toContain(
      `(p_permission = 'chart.read' and "organization_id" in (select "permdock".permitted_organization_ids('chart.read#break-glass')))`,
    );
    expect(sql).toContain(
      `(p_permission = 'chart.read' and "organization_id" in (select "permdock".member_organization_ids()))`,
    );
    expect(sql).not.toContain("(p_permission = 'chart.read')");
    expect(
      compileGrants(tenanted, scopedCtx, undefined, [], false).rolePermissions,
    ).toContainEqual({
      role: 'doctor',
      permission: 'chart.read',
      grantKey: 'chart.read#break-glass',
      scope: 'organization',
      effect: 'allow',
    });
  });

  it("reads every row through a grant to no role when the policy declares no scopes, whatever the CLI's default scope", () => {
    const sql = breakGlassSql(
      { ...ctx, scopes: [{ name: 'organization', key: 'organization_id' }] },
      breakGlassEntries(policy, undefined),
    );
    expect(sql).toContain("where (p_permission = 'patient.read');");
  });
});
