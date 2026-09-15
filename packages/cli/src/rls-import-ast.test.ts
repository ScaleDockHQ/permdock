import { describe, expect, it } from 'vitest';

import {
  canonicalDump,
  conditionFromAst,
  fingerprintSql,
} from './rls-import-ast.ts';
import { sqlFunctionNames } from './rls-sql.ts';

const memberships = {
  tenant: {
    table: 'organization_members',
    tenant: 'orgId',
    user: 'user_id',
    role: 'role',
  },
  team: {
    table: 'team_users',
    team: 'teamId',
    user: 'user_id',
    role: 'role',
  },
};

describe('conditionFromAst', () => {
  it('maps auth.uid equality, compounds, isNull and claims', async () => {
    const unmapped: string[] = [];
    expect(
      await conditionFromAst(
        '(select auth.uid()) = "authorId"',
        undefined,
        undefined,
        unmapped,
      ),
    ).toMatchObject({
      op: 'eq',
      field: 'authorId',
      value: { ref: 'principal.id' },
    });
    expect(
      await conditionFromAst(
        '"published" is null',
        undefined,
        undefined,
        unmapped,
      ),
    ).toEqual({ op: 'isNull', field: 'published', value: true });
    expect(
      await conditionFromAst('"n" is not null', undefined, undefined, unmapped),
    ).toEqual({ op: 'isNull', field: 'n', value: false });
    expect(
      await conditionFromAst(
        '"orgId" = ((select auth.jwt()) ->> \'tenant_id\')',
        undefined,
        undefined,
        unmapped,
      ),
    ).toMatchObject({
      op: 'eq',
      field: 'orgId',
      value: { ref: 'principal.claim.tenant_id' },
    });
    expect(
      await conditionFromAst(
        'current_setting(\'app.user_id\', true) = "authorId"',
        undefined,
        undefined,
        unmapped,
      ),
    ).toMatchObject({
      op: 'eq',
      field: 'authorId',
      value: { ref: 'principal.id' },
    });
    expect(
      await conditionFromAst(
        '"a" = 1 and not ("b" = 2) or "c" = \'x\'',
        undefined,
        undefined,
        unmapped,
      ),
    ).toMatchObject({ op: 'or' });
    expect(
      await conditionFromAst('true', undefined, undefined, unmapped),
    ).toEqual({ op: 'eq', field: '_', value: true });
    expect(unmapped).toEqual([]);
  });

  it('maps EXISTS and IN memberships and mapped functions', async () => {
    const unmapped: string[] = [];
    expect(
      await conditionFromAst(
        'exists (select 1 from organization_members m where m.organization_id = "orgId")',
        memberships,
        undefined,
        unmapped,
      ),
    ).toMatchObject({ op: 'memberOf', scope: 'tenant', field: 'orgId' });
    expect(
      await conditionFromAst(
        '"teamId" in (select team_id from team_users)',
        memberships,
        undefined,
        unmapped,
      ),
    ).toMatchObject({ op: 'memberOf', scope: 'team', field: 'teamId' });
    expect(
      await conditionFromAst(
        'job_permitted(id)',
        undefined,
        {
          job_permitted: {
            twin: {
              op: 'eq',
              field: 'authorId',
              value: { ref: 'principal.id' },
            },
            args: ['id'],
          },
        },
        unmapped,
      ),
    ).toMatchObject({
      op: 'sqlFunction',
      name: 'job_permitted',
      args: [{ field: 'id' }],
    });
    expect(
      await conditionFromAst(
        'unmapped_helper(id)',
        undefined,
        undefined,
        unmapped,
      ),
    ).toMatchObject({ op: 'opaque', sql: 'unmapped_helper(id)' });
    expect(unmapped).toContain('unmapped_helper');
  });

  it('fingerprints by deparsed AST and canonicalises dumps', async () => {
    const a = await fingerprintSql('(select auth.uid()) = "authorId"');
    const b = await fingerprintSql('((SELECT auth.uid())) = "authorId"');
    expect(a).toBe(b);
    const dump = await canonicalDump(
      'create policy "jobs_read" on job for select to authenticated using (job_permitted(id));',
    );
    expect(dump).toMatch(/CREATE POLICY/i);
    expect(dump).toContain('job_permitted');
  });
});

describe('sqlFunctionNames', () => {
  it('walks compounds and ignores leaves without a function', () => {
    expect(sqlFunctionNames(undefined)).toEqual([]);
    expect(
      sqlFunctionNames({
        op: 'and',
        conditions: [
          {
            op: 'sqlFunction',
            name: 'job_permitted',
            args: [{ field: 'id' }],
            twin: { op: 'eq', field: 'scope', value: 'public' },
          },
          { op: 'not', condition: { op: 'eq', field: 'hidden', value: true } },
        ],
      }),
    ).toEqual(['job_permitted']);
    expect(
      sqlFunctionNames({ op: 'opaque', sql: '1=1', fingerprint: 'x' }),
    ).toEqual([]);
  });
});
