import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { RelatedCondition } from '../conditions/ast.ts';
import type { RlsSqlContext } from './rls-sql.ts';

import { compileWhere } from '../conditions/compile.ts';
import { scopeList } from '../core/scopes.ts';
import {
  allow,
  definePermissions,
  definePolicy,
  relation,
  resource,
} from '../index.ts';
import { closureDepths, graphPlan, graphSql } from './rls-graph.ts';
import { compileConditionSql } from './rls-sql.ts';

const id = z.uuid();

const permissions = definePermissions({
  doc: resource(z.object({ id, folderId: id, restricted: z.boolean() }), {
    actions: ['read', 'update'],
    parent: { field: 'folderId', resource: 'folder' },
    restricted: 'restricted',
  }),
  folder: resource(z.object({ id, parentId: id.nullable() }), {
    actions: ['read'],
    parent: { field: 'parentId', resource: 'folder' },
    relations: {
      viewer: {
        edge: 'folder_viewers',
        object: 'folder',
        subject: 'member',
        expiresAt: 'until',
      },
      editor: { edge: 'app.folder_editors' },
    },
    restricted: 'hidden',
  }),
});

const policy = definePolicy(permissions, {
  grants: [
    allow(permissions.doc.read, {
      to: relation(permissions.folder, 'viewer', {
        through: 'parent',
        depth: 8,
      }),
    }),
    allow(permissions.doc.update, {
      to: relation(permissions.folder, 'editor', {
        through: 'parent',
        depth: 2,
      }),
    }),
    allow(permissions.folder.read, {
      to: relation(permissions.folder, 'editor'),
    }),
  ],
  subject: () => null,
});

function context(extra: Partial<RlsSqlContext> = {}): RlsSqlContext {
  const plan = graphPlan(policy);
  return {
    dialect: 'supabase',
    scopes: scopeList(policy.scopes),
    tenantClaim: 'tenant_id',
    gucPrefix: 'app',
    graph: { closures: closureDepths(plan) },
    ...extra,
  };
}

const related = (extra: Partial<RelatedCondition> = {}): RelatedCondition => ({
  op: 'related',
  resource: 'folder',
  relation: 'viewer',
  field: 'folderId',
  depth: 8,
  ...extra,
});

describe('graph grants in RLS', () => {
  it('plans the relations each resource needs and the deepest walk', () => {
    const plan = graphPlan(policy);
    expect([...plan.keys()]).toEqual(['folder']);
    expect([...(plan.get('folder')?.relations ?? [])].toSorted()).toEqual([
      'editor',
      'viewer',
    ]);
    expect(closureDepths(plan)).toEqual({ folder: 8 });
  });

  it('compiles to the closure subquery, a depth bound only below the cap, and the restricted row', () => {
    const ctx = context({ columnTypes: { folderId: 'uuid' } });
    expect(compileConditionSql(related(), ctx)).toBe(
      `"folderId" in (select descendant::uuid from "public".permdock_closure where resource = 'folder' and ancestor = any (array(select "public".permitted_folder_ids('viewer'))))`,
    );
    expect(
      compileConditionSql(
        related({
          relation: 'editor',
          depth: 2,
          parent: true,
          restricted: 'restricted',
        }),
        ctx,
      ),
    ).toBe(
      `("folderId" in (select descendant::uuid from "public".permdock_closure where resource = 'folder' and depth <= 2 and ancestor = any (array(select "public".permitted_folder_ids('editor')))) and "restricted" is not true)`,
    );
    expect(
      compileConditionSql(related({ field: 'id', depth: 0 }), context()),
    ).toBe(`"id"::text in (select "public".permitted_folder_ids('viewer'))`);
  });

  it('emits helpers, the closure table and triggers that stop at restricted rows and the depth', () => {
    const sql = graphSql(context(), graphPlan(policy), {
      folder: 'app.folders',
    });
    expect(sql).not.toMatch(/service_role/iu);
    expect(sql).toContain(
      'create table if not exists "public".permdock_closure',
    );
    expect(sql).toContain('e."member"::text = (select auth.uid())::text');
    expect(sql).toContain('(e."until" is null or e."until" > now())');
    expect(sql).toContain('from "app"."folder_editors" e');
    expect(sql).toContain('coalesce(p."hidden", false)');
    expect(sql).toContain('walk.depth < 8');
    expect(sql).toContain('after update on "app"."folders"');
    expect(sql).toContain(
      'referencing old table as old_rows new table as new_rows',
    );
    expect(sql).toContain('is its own ancestor');
    expect(sql).toContain(
      `using (resource = 'folder' and ancestor in (select "public".permitted_folder_ids(null)))`,
    );
    expect(sql).toContain(
      'revoke execute on function "public".permdock_closure_folder(text[]) from public, anon, authenticated;',
    );
  });

  it('refuses a graph resource named like a scope', () => {
    const clash = definePermissions({
      team: resource({
        actions: ['read'],
        parent: { field: 'parentId', resource: 'team' },
        relations: { lead: { edge: 'team_leads' } },
      }),
    });
    const clashing = definePolicy(clash, {
      grants: [
        allow(clash.team.read, {
          to: relation(clash.team, 'lead', { through: 'parent' }),
        }),
      ],
      subject: () => null,
    });
    const plan = graphPlan(clashing);
    expect(() =>
      graphSql(
        {
          dialect: 'supabase',
          scopes: scopeList(clashing.scopes),
          tenantClaim: 'tenant_id',
          gucPrefix: 'app',
        },
        plan,
        undefined,
      ),
    ).toThrow(/PD032/);
    expect(closureDepths(plan)).toEqual({ team: 16 });
  });

  it('is not portable to toWhere compilers', () => {
    expect(() => compileWhere(related())).toThrow(/related/);
  });
});
