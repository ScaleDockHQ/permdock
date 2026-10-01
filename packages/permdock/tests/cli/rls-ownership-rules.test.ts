import { describe, expect, it } from 'vitest';

import type { RlsSqlContext } from '../../src/cli/rls-sql.ts';

import { ownershipRules, ownershipSql } from '../../src/cli/rls-ownership.ts';
import { scopeList } from '../../src/core/scopes.ts';
import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
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
  doc: resource(Doc, {
    id: 'id',
    actions: ['read'],
    relations: {
      org: { field: 'org_id', memberOf: 'org' },
      team: { field: 'team_id', memberOf: 'team' },
    },
  }),
});

const roles = defineRoles({
  operator: {},
  owner: { on: 'org' },
  manager: { on: 'team' },
  lead: { on: 'team' },
  editor: {},
});

const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { org: { key: 'org_id' }, team: { key: 'team_id', within: 'org' } },
    // SAFETY: SQL generation never calls the subject mapper.
    subject: (user: unknown) => user as never,
    roles: [
      role(roles.operator, [allow(permissions.doc.read)], {
        assigns: ['owner', 'editor'],
        for: ['staff'],
      }),
      role(roles.owner, [allow(permissions.doc.read)], {
        on: 'org',
        min: 1,
        max: 2,
        transferOnly: true,
        assigns: ['manager'],
      }),
      role(roles.manager, [allow(permissions.doc.read)], {
        on: 'team',
        max: 3,
      }),
      role(roles.lead, [allow(permissions.doc.read)], {
        on: 'team',
        assigns: ['owner', 'manager'],
      }),
      role(roles.editor, [allow(permissions.doc.read)], {
        on: permissions.doc,
        assigns: ['owner'],
      }),
    ],
  },
);

const scopes = scopeList(policy.scopes);
const ownership = ownershipRules(policy, scopes);

function context(extra: Partial<RlsSqlContext>): RlsSqlContext {
  return {
    dialect: 'supabase',
    scopes,
    tenantClaim: 'tenant_id',
    gucPrefix: 'app',
    tenantType: 'text',
    ...(ownership === undefined ? {} : { ownership }),
    ...extra,
  };
}

const orgTable = {
  table: 'org_members',
  user: 'user_id',
  role: 'role',
  expiresAt: 'expires_at',
  via: 'via',
  columns: { org: 'org_id' },
};

describe('ownershipRules', () => {
  it('keeps assign pairs inside the scope chain and counts min, max and transferOnly', () => {
    expect(ownership).toEqual({
      kinds: { operator: ['staff'] },
      assigns: [
        { assigner: 'operator', scope: 'global', role: 'owner' },
        { assigner: 'owner', scope: 'org', role: 'manager' },
        { assigner: 'lead', scope: 'team', role: 'manager' },
      ],
      counted: [
        { role: 'owner', scope: 'org', min: 1, max: 2, transferOnly: true },
        { role: 'manager', scope: 'team', min: 0, max: 3, transferOnly: false },
      ],
    });
  });
});

describe('ownershipSql in database mode', () => {
  const sql = ownershipSql(
    context({
      authorize: 'database',
      memberships: { scopes: { org: orgTable } },
    }),
  );

  it('writes min and max checks with expiry and kind filters on the mapped table', () => {
    expect(sql).toContain('create constraint trigger "permdock_holders_org"');
    expect(sql).toContain('keeps at least 1 owner');
    expect(sql).toContain('has at most 2 owner');
    expect(sql).toContain('(m."expires_at" is null or m."expires_at" > now())');
    expect(sql).toContain('-- team: no memberships table configured');
  });

  it('writes the transfer-only statement triggers for insert, update and delete', () => {
    for (const op of ['insert', 'update', 'delete']) {
      expect(sql).toContain(
        `create trigger "permdock_transfer_only_org_${op}"`,
      );
    }
    expect(sql).toContain('referencing new table as permdock_new\n');
    expect(sql).toContain('referencing old table as permdock_old\n');
    expect(sql).toContain(
      'referencing old table as permdock_old new table as permdock_new',
    );
    expect(sql).toContain("array['owner']::text[]");
  });

  it('checks global and mapped-scope assigners in permdock_can_assign', () => {
    const canAssign = sql.slice(sql.indexOf('-- who may assign'));
    expect(canAssign).toContain("in (values ('operator', 'owner'))");
    expect(canAssign).toContain("in (values ('owner', 'manager'))");
    expect(canAssign).not.toContain("('lead', 'manager')");
    expect(sql).not.toMatch(/service_role/iu);
  });
});

describe('ownershipSql in jwt mode', () => {
  it('reads roles and memberships from the claims', () => {
    const sql = ownershipSql(context({ authorize: 'jwt' }));
    const canAssign = sql.slice(sql.indexOf('-- who may assign'));
    expect(canAssign).toContain(
      "(r.role, p_role) in (values ('operator', 'owner'))",
    );
    expect(canAssign).toContain("m ->> 'scope' = 'org'");
    expect(canAssign).toContain("m ->> 'scope' = 'team'");
    expect(sql).toContain('-- org: no memberships table configured');
  });

  it('answers false when no assigner can be checked', () => {
    const sql = ownershipSql(
      context({
        authorize: 'database',
        ownership: {
          kinds: {},
          assigns: [{ assigner: 'lead', scope: 'team', role: 'manager' }],
          counted: [],
        },
      }),
    );
    expect(sql).toMatch(/and \(\n {4}false\n {2}\)/u);
  });
});
