import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { RelatedCondition } from '../../src/conditions/ast.ts';
import type {
  GraphSql,
  GraphSqlOptions,
} from '../../src/conditions/graph-sql.ts';
import type { ResourceNode } from '../../src/core/permissions.ts';

import {
  holderIdsSql,
  quoteSqlName,
  relatedSql,
  relatedTargetsSql,
  relationArmSql,
  renderGraphSql,
} from '../../src/conditions/graph-sql.ts';
import {
  definePermissions,
  getRegistry,
  resource,
} from '../../src/core/permissions.ts';
import { permissions } from '../fixtures/graph.ts';

const resources: ReadonlyMap<string, ResourceNode> = getRegistry(permissions);

function render(parts: GraphSql) {
  return renderGraphSql(parts, {
    subject: 'u1',
    placeholder: (index) => `$${String(index)}`,
    column: (name) => `row.${quoteSqlName(name)}`,
  });
}

const options: GraphSqlOptions = { resources };

const folderViewer: RelatedCondition = {
  op: 'related',
  resource: 'folder',
  relation: 'viewer',
  field: 'folderId',
  depth: 4,
  parent: true,
  restricted: 'restricted',
};

describe('graph SQL', () => {
  it('quotes names and refuses unsafe ones', () => {
    expect(quoteSqlName('public.folder')).toBe('"public"."folder"');
    expect(quoteSqlName('we"ird')).toBe('"we""ird"');
    expect(() => quoteSqlName('a\0b')).toThrow(/unsafe SQL identifier/u);
    expect(() => quoteSqlName('a..b')).toThrow(/sql identifier/u);
    expect(() => quoteSqlName('__proto__')).toThrow(/sql identifier/u);
  });

  it('unions the implying relations and filters the edge by match and expiry', () => {
    const { sql, values } = render(holderIdsSql('folder', 'viewer', options));
    expect(sql.match(/ union /gu)?.length).toBeGreaterThanOrEqual(1);
    expect(sql).toContain('"role" = $');
    expect(sql).toContain('"expires_at" is null or');
    expect(values).toContain('viewer');
    expect(values).toContain('editor');
    expect(values).toContain('u1');
  });

  it('reads group members, recursing through groups of the same resource', () => {
    const { sql, values } = render(relationArmSql('team', 'member', options));
    expect(sql).toContain('with recursive');
    expect(sql).toContain('.level < 16');
    expect(values).toContain('team');
    expect(values).toContain('user');
    const folder = render(relationArmSql('folder', 'editor', options));
    expect(folder.sql).toContain('"team_members"');
  });

  it('uses the caller helper for group holders when given', () => {
    const { sql } = render(
      holderIdsSql('folder', 'editor', {
        ...options,
        holders: (group, relation) => [
          { text: `select id from helper_${group}_${relation}` },
        ],
      }),
    );
    expect(sql).toContain('select id from helper_team_member');
  });

  it('compiles principal, field and period relations and refuses memberOf', () => {
    const extra = definePermissions({
      employee: resource(
        z.object({
          id: z.string(),
          managerId: z.string(),
          ownerId: z.string(),
          orgId: z.string(),
        }),
        {
          actions: ['read'],
          parent: { field: 'managerId', resource: 'employee' },
          relations: {
            manager: {
              principal: 'managerId',
              period: { startsAt: 'from', expiresAt: 'until' },
            },
            owner: 'ownerId',
            org: { field: 'orgId', memberOf: 'tenant' },
          },
        },
      ),
    });
    const extraOptions: GraphSqlOptions = {
      resources: getRegistry(extra),
      tables: { employee: 'staff' },
      qualify: (name) => `app.${name}`,
    };
    const manager = render(
      relationArmSql('employee', 'manager', extraOptions),
    ).sql;
    expect(manager).toContain('from "app"."staff"');
    expect(manager).toContain('"from" is null or');
    expect(manager).toContain('"until" is null or');
    expect(
      render(relationArmSql('employee', 'owner', extraOptions)).sql,
    ).toContain('"ownerId" = $1');
    expect(() => relationArmSql('employee', 'org', extraOptions)).toThrow(
      /no graph SQL form/u,
    );
    expect(() => relationArmSql('nothing', 'org', extraOptions)).toThrow(
      /not declared/u,
    );
  });

  it('walks the closure table, capped by its depth', () => {
    const closure = render(
      relatedSql(folderViewer, {
        ...options,
        closure: 'public.permdock_closure',
      }),
    ).sql;
    expect(closure).toMatch(/^\(coalesce\(row\."folderId"::text in \(/u);
    expect(closure).toContain('from "public"."permdock_closure" c');
    expect(closure).toContain('.depth <= 4');
    expect(closure).toMatch(/and row\."restricted" is not true\)$/u);

    const capped = render(
      relatedSql(folderViewer, {
        ...options,
        closure: 'permdock_closure',
        closureDepths: { folder: 4 },
      }),
    ).sql;
    expect(capped).not.toContain('.depth <=');

    const uncovered = render(
      relatedSql(folderViewer, {
        ...options,
        closure: 'permdock_closure',
        closureDepths: {},
      }),
    ).sql;
    expect(uncovered).not.toContain('permdock_closure');
  });

  it('walks the table recursively without a closure, stopping at restricted rows', () => {
    const { sql } = render(relatedTargetsSql(folderViewer, options));
    expect(sql).toContain('with recursive');
    expect(sql).toContain('.level < 4 and');
    expect(sql).toContain('"restricted" is not true');
  });

  it('reads held ids from a resource role list', () => {
    const empty = render(
      relatedTargetsSql(
        { ...folderViewer, relation: '', ids: [], depth: 0 },
        options,
      ),
    );
    expect(empty.sql).toBe('select null::text as id where false');
    const listed = render(
      relatedTargetsSql(
        { ...folderViewer, relation: '', ids: ['a', 'b'], depth: 0 },
        options,
      ),
    );
    expect(listed.sql).toBe(
      'select v.id from (values ($1::text), ($2::text)) as v(id)',
    );
    expect(listed.values).toEqual(['a', 'b']);
  });

  it('carries reached ids back over link hops, or through the caller helper', () => {
    const review: RelatedCondition = {
      op: 'related',
      resource: 'team',
      relation: 'lead',
      field: 'folderId',
      depth: 0,
      hops: [
        { link: 'folder', resource: 'folder' },
        { link: 'team', resource: 'team' },
      ],
    };
    const inline = render(relatedSql(review, options)).sql;
    expect(inline).toContain('from "folder" t');
    expect(inline).toContain('"teamId"::text in (');
    const helper = render(
      relatedSql(review, {
        ...options,
        linked: (from, link, targets) => [
          { text: `select link_${from}_${link}(` },
          ...targets,
          { text: ')' },
        ],
      }),
    ).sql;
    expect(helper).toContain('select link_folder_team(');
    expect(() =>
      relatedSql(
        {
          ...review,
          hops: [
            { link: 'folder', resource: 'folder' },
            { link: 'owner', resource: 'team' },
          ],
        },
        options,
      ),
    ).toThrow(/has no link 'owner'/u);
  });

  it('refuses a walk over a resource that is not self-parented', () => {
    expect(() =>
      relatedSql(
        { ...folderViewer, resource: 'team', relation: 'lead', depth: 2 },
        options,
      ),
    ).toThrow(/not self-parented/u);
  });
});
