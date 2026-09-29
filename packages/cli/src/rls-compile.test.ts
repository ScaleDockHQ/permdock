import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  resource,
  role,
} from 'permdock';
import { describe, expect, it } from 'vitest';

import { compileGrant } from './rls-compile.ts';
import { collectGrants } from './rls-grants.ts';
import { compileConditionSql } from './rls-sql.ts';

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

function usingFor(key: string): string | undefined {
  const grant = collectGrants(policy).find(
    (candidate) => candidate.grant.permission.key === key,
  );
  if (grant === undefined) {
    throw new Error(`no grant for ${key}`);
  }
  return compileGrant(grant, policy, ctx, undefined, undefined, [], false)
    ?.using;
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
    const grant = collectGrants(chainedPolicy)[0]!;
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
    const sql = compileGrant(
      grant,
      chainedPolicy,
      withProject,
      undefined,
      undefined,
      [],
      false,
    )?.using;
    expect(sql).toContain(
      '"folder_members" m where m."folder_id" = "folderId"',
    );
    expect(sql).toContain(
      '"project_members" m where m."project_id" = "projectId"',
    );
    expect(
      compileGrant(grant, chainedPolicy, ctx, undefined, undefined, [], false)
        ?.using,
    ).not.toContain('project_members');
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
