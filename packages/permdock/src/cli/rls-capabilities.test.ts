import { describe, expect, it } from 'vitest';

import type { RlsSqlContext } from './rls-sql.ts';

import { scopeList } from '../core/scopes.ts';
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from '../index.ts';
import { compileGrants } from './rls-compile.ts';
import { helpersSql } from './rls-helpers.ts';
import { assemblePolicies } from './rls-policies.ts';

const permissions = definePermissions({
  quote: resource({
    actions: ['read', 'accept'],
    relations: { org: { field: 'orgId', memberOf: 'tenant' } },
  }),
  folder: resource({ actions: ['read'] }),
  file: resource({
    parent: { field: 'folderId', resource: 'folder' },
    actions: ['read', 'update'],
  }),
});
const policy = definePolicy(permissions, {
  subject: () => null,
  scopes: { tenant: { key: 'orgId' } },
  roles: [
    role('staff', [allow(permissions.quote.read)], { on: 'tenant' }),
    role(
      'guest',
      [allow(permissions.quote.read, { where: { status: 'sent' } })],
      {
        on: permissions.quote,
      },
    ),
    role('commenter', [allow(permissions.file.read)], {
      on: permissions.folder,
    }),
  ],
});
const base: RlsSqlContext = {
  dialect: 'supabase',
  tenantClaim: 'tenant_id',
  scopes: scopeList(policy.scopes),
  gucPrefix: 'app',
};

function generate(ctx: RlsSqlContext) {
  const warnings: string[] = [];
  const compiled = compileGrants(policy, ctx, undefined, warnings, false);
  return {
    warnings,
    helpers: helpersSql(ctx, compiled.rolePermissions, { userRoles: false }),
    policies: assemblePolicies(compiled.branches, { perRole: false }),
  };
}

describe('rls generate --capabilities', () => {
  it('reaches link-only resource roles through anon policies', () => {
    const { policies, helpers, warnings } = generate({
      ...base,
      capabilities: true,
    });
    expect(
      policies.map((item) => [item.name, item.roles.join(','), item.using]),
    ).toEqual([
      [
        'quote_select',
        'authenticated',
        `"orgId" in (select "public".permitted_tenant_ids('quote.read'))`,
      ],
      [
        'quote_select_anon',
        'anon',
        `("id"::text in (select "public".permdock_capability_ids('quote', 'guest', 'quote.read'))) and ("status" = 'sent')`,
      ],
      [
        'file_select_anon',
        'anon',
        `"folderId"::text in (select "public".permdock_capability_ids('folder', 'commenter', 'file.read'))`,
      ],
    ]);
    expect(warnings).toEqual([
      'no quote memberships table: only link capabilities reach guest/quote.read',
      'no folder memberships table: only link capabilities reach commenter/file.read',
    ]);
    expect(helpers).toContain(
      `create or replace function "public".permdock_capability_ids(p_resource text, p_role text, p_permission text)`,
    );
    expect(helpers).toContain(`((select auth.jwt()) -> 'capability')`);
    expect(helpers).toContain(
      `grant execute on function "public".permdock_capability_ids(text, text, text) to anon, authenticated;`,
    );
    expect(helpers).not.toMatch(/service_role/u);
  });

  it('keeps member branches next to link branches when a table is mapped', () => {
    const { policies, warnings } = generate({
      ...base,
      capabilities: true,
      memberships: {
        resource: {
          quote: {
            table: 'quote_members',
            id: 'quote_id',
            user: 'user_id',
            role: 'role',
          },
        },
      },
    });
    const select = policies.find((item) => item.name === 'quote_select');
    expect(select?.using).toContain('quote_members');
    expect(policies.some((item) => item.name === 'quote_select_anon')).toBe(
      true,
    );
    expect(warnings).toEqual([
      'no folder memberships table: only link capabilities reach commenter/file.read',
    ]);
  });

  it('emits no capability objects without the flag', () => {
    expect(() => generate(base)).toThrow(/memberships table mapping/u);
    const { helpers, policies } = generate({
      ...base,
      memberships: {
        resource: {
          quote: {
            table: 'quote_members',
            id: 'quote_id',
            user: 'user_id',
            role: 'role',
          },
          folder: {
            table: 'folder_members',
            id: 'folder_id',
            user: 'user_id',
            role: 'role',
          },
        },
      },
    });
    expect(helpers).not.toContain('permdock_capability_ids');
    expect(policies.every((item) => !item.roles.includes('anon'))).toBe(true);
  });

  it('gives no link branch to a role whose for omits link', () => {
    const anonNames = (kinds: readonly string[]) =>
      generate({
        ...base,
        capabilities: true,
        ownership: { kinds: { guest: kinds }, assigns: [], counted: [] },
      })
        .policies.filter((item) => item.roles.includes('anon'))
        .map((item) => item.name);
    expect(anonNames(['staff'])).not.toContain('quote_select_anon');
    expect(anonNames(['link'])).toContain('quote_select_anon');
  });
});
