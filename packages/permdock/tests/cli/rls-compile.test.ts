import { describe, expect, it } from 'vitest';

import type { RlsSqlContext } from '../../src/cli/rls-sql.ts';

import { branchClauses, compileGrants } from '../../src/cli/rls-compile.ts';
import { compileConditionSql } from '../../src/cli/rls-sql.ts';
import { scopeList } from '../../src/core/scopes.ts';
import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  resource,
  role,
} from '../../src/index.ts';

const permissions = definePermissions({
  folder: resource({ actions: ['read'] }),
  file: resource({
    parent: { field: 'folderId', resource: 'folder' },
    actions: ['read'],
  }),
});
const roles = defineRoles({ editor: { assignable: true } });
const policy = definePolicy(
  { permissions, roles },
  {
    subject: () => null,
    roles: [
      role(
        roles.editor,
        [allow([permissions.folder.read, permissions.file.read])],
        { on: permissions.folder },
      ),
    ],
  },
);
const ctx = {
  dialect: 'supabase',
  tenantClaim: 'tenant',
  gucPrefix: 'permdock',
  memberships: {
    resource: {
      folder: {
        table: 'folder_members',
        user: 'user_id',
        role: 'role',
        id: 'folder_id',
      },
    },
  },
} as const;

function usingOf(
  target: typeof policy | typeof chainedPolicy,
  key: string,
  context: RlsSqlContext,
): string | undefined {
  const branch = compileGrants(
    target,
    context,
    undefined,
    [],
    false,
  ).branches.find(
    (candidate) =>
      candidate.permissionKey === key && candidate.coverage === undefined,
  );
  if (branch === undefined) {
    throw new Error(`no grant for ${key}`);
  }
  return branchClauses(branch).using;
}

function usingFor(key: string): string | undefined {
  return usingOf(policy, key, ctx);
}

const chained = definePermissions({
  project: resource({ actions: ['read'] }),
  folder: resource({
    parent: { field: 'projectId', resource: 'project' },
    actions: ['read'],
  }),
  doc: resource({
    parent: { field: 'folderId', resource: 'folder' },
    actions: ['read'],
  }),
});
const chainedPolicy = definePolicy(
  { permissions: chained, roles },
  {
    subject: () => null,
    roles: [
      role(roles.editor, [allow(chained.doc.read)], { on: chained.folder }),
    ],
  },
);

describe('compileGrant resource scope', () => {
  it('ors the role resource and each mapped ancestor by its row field', () => {
    const withProject = {
      ...ctx,
      memberships: {
        resource: {
          ...ctx.memberships.resource,
          project: {
            table: 'project_members',
            user: 'user_id',
            role: 'role',
            id: 'project_id',
          },
        },
      },
    };
    const sql = usingOf(chainedPolicy, 'doc.read', withProject);
    expect(sql).toContain(
      '"folder_members" m where m."folder_id" = "folderId"',
    );
    expect(sql).toContain(
      '"project_members" m where m."project_id" = "projectId"',
    );
    expect(usingOf(chainedPolicy, 'doc.read', ctx)).not.toContain(
      'project_members',
    );
  });

  it('keys the role resource by its id and a child row by its parent field', () => {
    expect(usingFor('folder.read')).toContain('m."folder_id" = "id"');
    const child = usingFor('file.read');
    expect(child).toContain('m."folder_id" = "folderId"');
    expect(child).not.toContain('m."folder_id" = "id"');
  });

  it('compiles a keyed parent hop through that resource mapping only', () => {
    const sql = compileConditionSql(
      {
        op: 'memberOf',
        scope: 'resource',
        resource: 'folder',
        field: 'id',
        roles: ['editor'],
        parents: [
          { field: 'projectId', resource: 'project' },
          { field: 'orgId', resource: 'org' },
        ],
      },
      {
        ...ctx,
        memberships: {
          resource: {
            ...ctx.memberships.resource,
            project: {
              table: 'project_members',
              user: 'user_id',
              role: 'role',
              id: 'project_id',
            },
          },
        },
      },
    );
    expect(sql).toContain(
      '"project_members" m where m."project_id" = "projectId"',
    );
    expect(sql).not.toContain('"orgId"');
  });
});

describe('tenant claim casts', () => {
  const base = {
    dialect: 'supabase',
    tenantClaim: 'tenant_id',
    scopes: scopeList(undefined),
    gucPrefix: 'app',
  } as const;

  it('casts the tenant claim to the column type, uuid by default', () => {
    const condition = {
      op: 'eq',
      field: 'orgId',
      value: { ref: 'principal.tenant' },
    } as const;
    expect(compileConditionSql(condition, base)).toBe(
      `"orgId" = ((select auth.jwt()) ->> 'tenant_id')::uuid`,
    );
    expect(
      compileConditionSql(
        { ...condition, value: { ref: 'principal.claim.tenant_id' } },
        { ...base, dialect: 'guc', tenantType: 'bigint' },
      ),
    ).toBe(`"orgId" = current_setting('app.tenant_id', true)::bigint`);
    expect(
      compileConditionSql(
        { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: [] },
        { ...base, tenantType: 'text' },
      ),
    ).toBe(`"orgId" = ((select auth.jwt()) ->> 'tenant_id')::text`);
  });

  it('leaves other claims as text and rejects an unsafe type', () => {
    expect(
      compileConditionSql(
        { op: 'eq', field: 'plan', value: { ref: 'principal.claim.plan' } },
        base,
      ),
    ).toBe(`"plan" = ((select auth.jwt()) ->> 'plan')`);
    expect(() =>
      compileConditionSql(
        { op: 'eq', field: 'orgId', value: { ref: 'principal.tenant' } },
        { ...base, tenantType: 'uuid; drop table x' },
      ),
    ).toThrow(/unsafe SQL type/u);
  });
});

describe('compileGrants approval grants', () => {
  it('skips every grant that requires approval, not only human', () => {
    const tree = definePermissions({
      invoice: resource({
        actions: ['read', 'pay', 'void', 'close'],
        version: 'updatedAt',
      }),
    });
    const withApprovals = definePolicy(tree, {
      subject: () => null,
      roles: [
        role('clerk', [
          allow(tree.invoice.read),
          allow(tree.invoice.pay, { approval: 'human' }),
          allow(tree.invoice.void, { approval: { distinct: false } }),
          allow(tree.invoice.close, {
            approval: { staleOn: 'resource-change' },
          }),
        ]),
      ],
    });
    const warnings: string[] = [];
    const { branches } = compileGrants(
      withApprovals,
      ctx,
      undefined,
      warnings,
      false,
    );
    expect(branches.map((branch) => branch.permissionKey)).toEqual([
      'invoice.read',
    ]);
    expect(warnings).toEqual([
      'skipped approval grant clerk/invoice.pay',
      'skipped approval grant clerk/invoice.void',
      'skipped approval grant clerk/invoice.close',
    ]);
  });
});

describe('memberOf and suspension', () => {
  const scopes = scopeList(
    definePolicy(permissions, {
      subject: () => null,
      scopes: {
        organization: { key: 'organization_id' },
        team: { key: 'team_id', within: 'organization' },
      },
    }).scopes,
  );
  const user = `exists (select 1 from "public"."profiles" s where s."id" = (select auth.uid()) and s."disabled_at" is null)`;
  const suspended = {
    dialect: 'supabase',
    tenantClaim: 'tenant_id',
    tenantType: 'text',
    gucPrefix: 'app',
    scopes,
    suspension: {
      users: { table: 'profiles', id: 'id', disabledAt: 'disabled_at' },
      scopes: {
        organization: { table: 'orgs', id: 'id', disabledAt: 'disabled_at' },
        team: { table: 'teams', id: 'id', status: 'state', active: ['open'] },
      },
    },
  } as const;

  it('checks the user and every instance on the chain in a role-bound exists', () => {
    const sql = compileConditionSql(
      { op: 'memberOf', scope: 'team', field: 'team_id', roles: ['lead'] },
      {
        ...suspended,
        memberships: {
          scopes: {
            team: {
              table: 'team_members',
              user: 'user_id',
              role: 'role',
              columns: { team: 'team_id', organization: 'organization_id' },
            },
          },
        },
      },
    );
    expect(sql).toContain('"team_members" m where');
    expect(sql).toContain(user);
    expect(sql).toContain(
      `exists (select 1 from "public"."teams" s where s."id" = (m."team_id")::text and s."state"::text = any(array['open']::text[]))`,
    );
    expect(sql).toContain(
      `exists (select 1 from "public"."orgs" s where s."id" = (m."organization_id")::text and s."disabled_at" is null)`,
    );
  });

  it('checks the user and the tenant in the root-scope claim fallback', () => {
    const sql = compileConditionSql(
      {
        op: 'memberOf',
        scope: 'organization',
        field: 'organization_id',
        roles: [],
      },
      suspended,
    );
    expect(sql).toContain(
      `"organization_id" = ((select auth.jwt()) ->> 'tenant_id')::text`,
    );
    expect(sql).toContain(user);
    expect(sql).toContain(
      `exists (select 1 from "public"."orgs" s where s."id" = ("organization_id")::text and s."disabled_at" is null)`,
    );
  });

  it('leaves the SQL unchanged without suspension', () => {
    const { suspension: _suspension, ...plain } = suspended;
    expect(
      compileConditionSql(
        {
          op: 'memberOf',
          scope: 'organization',
          field: 'organization_id',
          roles: [],
        },
        plain,
      ),
    ).toBe(`"organization_id" = ((select auth.jwt()) ->> 'tenant_id')::text`);
  });
});
