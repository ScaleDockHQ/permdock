import { describe, expect, it } from 'vitest';

import type { Subject } from '../core/subject.ts';
import type { Condition } from './ast.ts';

import { PermDockValidationError } from '../core/errors.ts';
import { compileWhere } from './compile.ts';
import { opaque } from './opaque.ts';
import { principal } from './refs.ts';
import { sqlFunction } from './sql-function.ts';

const now = 1_700_000_000;

function sub(
  who: NonNullable<Subject['principal']>,
  ctx: Subject['context'] = {},
): Subject {
  return { principal: who, context: ctx };
}

describe('compileWhere', () => {
  it('fails closed on an empty or', () => {
    expect(compileWhere({ op: 'or', conditions: [] })).toEqual({
      kind: 'never',
    });
  });

  it('treats unconditional allow as always and false as never', () => {
    expect(compileWhere({ op: 'eq', field: '_', value: true })).toEqual({
      kind: 'always',
    });
    expect(compileWhere({ op: 'eq', field: '_', value: false })).toEqual({
      kind: 'never',
    });
  });

  it('unwraps a portable WhereResult and rejects partial or opaque', () => {
    expect(
      compileWhere({
        condition: { op: 'eq', field: 'authorId', value: 'u1' },
        partial: false,
      }),
    ).toEqual({ kind: 'compare', op: 'eq', field: 'authorId', value: 'u1' });
    expect(() =>
      compileWhere({
        condition: { op: 'eq', field: 'authorId', value: 'u1' },
        partial: true,
      }),
    ).toThrow(PermDockValidationError);
    expect(() =>
      compileWhere(opaque({ sql: 'select 1', fingerprint: 'x' })),
    ).toThrow(PermDockValidationError);
    expect(
      compileWhere(
        sqlFunction('job_permitted', {
          args: [{ field: 'id' }],
          twin: { op: 'eq', field: 'authorId', value: 'u1' },
        }),
      ),
    ).toEqual({ kind: 'compare', op: 'eq', field: 'authorId', value: 'u1' });
  });

  it('resolves subject refs and dates, and fails closed on empty in', () => {
    const who = sub({ id: 'u1', orgId: 'o1' }, { teamIds: ['t1', 't2'] });
    expect(
      compileWhere(
        { op: 'eq', field: 'authorId', value: principal.id },
        { subject: who },
      ),
    ).toEqual({ kind: 'compare', op: 'eq', field: 'authorId', value: 'u1' });
    expect(
      compileWhere(
        {
          op: 'in',
          field: 'teamId',
          value: { ref: 'context.teamIds' },
        },
        { subject: who },
      ),
    ).toEqual({
      kind: 'compare',
      op: 'in',
      field: 'teamId',
      value: ['t1', 't2'],
    });
    expect(
      compileWhere({
        op: 'gt',
        field: 'due',
        value: { date: '2026-01-01' },
      }),
    ).toEqual({
      kind: 'compare',
      op: 'gt',
      field: 'due',
      value: new Date('2026-01-01'),
    });
    expect(compileWhere({ op: 'in', field: 'id', value: [] })).toEqual({
      kind: 'never',
    });
    expect(compileWhere({ op: 'notIn', field: 'id', value: [] })).toEqual({
      kind: 'isNull',
      field: 'id',
      negated: true,
    });
  });

  it('simplifies and / or / not and compiles isNull', () => {
    expect(
      compileWhere({
        op: 'and',
        conditions: [
          { op: 'eq', field: '_', value: true },
          { op: 'eq', field: 'authorId', value: 'u1' },
        ],
      }),
    ).toEqual({ kind: 'compare', op: 'eq', field: 'authorId', value: 'u1' });
    expect(
      compileWhere({
        op: 'or',
        conditions: [
          { op: 'eq', field: '_', value: false },
          { op: 'eq', field: 'authorId', value: 'u1' },
        ],
      }),
    ).toEqual({ kind: 'compare', op: 'eq', field: 'authorId', value: 'u1' });
    expect(
      compileWhere({
        op: 'not',
        condition: { op: 'eq', field: '_', value: true },
      }),
    ).toEqual({ kind: 'never' });
    expect(
      compileWhere({ op: 'isNull', field: 'deletedAt', value: true }),
    ).toEqual({ kind: 'isNull', field: 'deletedAt', negated: false });
    expect(
      compileWhere({ op: 'isNull', field: 'deletedAt', value: false }),
    ).toEqual({ kind: 'isNull', field: 'deletedAt', negated: true });
  });

  it('compiles memberOf tenant as equality, in-list or never', () => {
    const member = sub({
      id: 'u1',
      tenant: 'o1',
      memberships: [
        { tenant: 'o1', roles: ['viewer'] },
        { tenant: 'o2', roles: ['viewer'] },
        { tenant: 'old', roles: ['viewer'], expiresAt: now - 10 },
      ],
    });
    expect(
      compileWhere(
        { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: ['viewer'] },
        { subject: member, now },
      ),
    ).toEqual({ kind: 'compare', op: 'eq', field: 'orgId', value: 'o1' });
    expect(
      compileWhere(
        { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: ['admin'] },
        { subject: member, now },
      ),
    ).toEqual({ kind: 'never' });
    const noActive = sub({
      id: 'u1',
      memberships: [
        { tenant: 'o1', roles: ['viewer'] },
        { tenant: 'o2', roles: ['viewer'] },
      ],
    });
    expect(
      compileWhere(
        { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: ['viewer'] },
        { subject: noActive, now },
      ),
    ).toEqual({
      kind: 'compare',
      op: 'in',
      field: 'orgId',
      value: ['o1', 'o2'],
    });
  });

  it('filters memberOf team by the active tenant and derives resource parents', () => {
    const member = sub({
      id: 'u1',
      tenant: 'o1',
      memberships: [
        { tenant: 'o1', team: 't1', roles: ['lead'] },
        { tenant: 'o2', team: 't2', roles: ['lead'] },
        { on: { resource: 'document', id: 'd1' }, roles: ['editor'] },
        { on: { resource: 'folder', id: 'f1' }, roles: ['editor'] },
      ],
    });
    expect(
      compileWhere(
        { op: 'memberOf', scope: 'team', field: 'teamId', roles: ['lead'] },
        { subject: member, now },
      ),
    ).toEqual({ kind: 'compare', op: 'eq', field: 'teamId', value: 't1' });
    expect(
      compileWhere(
        {
          op: 'memberOf',
          scope: 'resource',
          field: 'id',
          roles: ['editor'],
          resource: 'document',
          parents: ['folderId'],
        },
        { subject: member, now },
      ),
    ).toEqual({
      kind: 'or',
      items: [
        { kind: 'compare', op: 'eq', field: 'id', value: 'd1' },
        {
          kind: 'compare',
          op: 'in',
          field: 'folderId',
          value: ['d1', 'f1'],
        },
      ],
    });
  });

  it('emits exists when a memberships mapping is set', () => {
    const member = sub({ id: 'u1', tenant: 'o1' });
    expect(
      compileWhere(
        { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: ['viewer'] },
        {
          subject: member,
          memberships: {
            tenant: {
              table: 'organization_members',
              user: 'user_id',
              role: 'role',
              tenant: 'organization_id',
              expiresAt: 'expires_at',
            },
          },
        },
      ),
    ).toEqual({
      kind: 'exists',
      table: 'organization_members',
      user: 'user_id',
      userValue: 'u1',
      role: 'role',
      roles: ['viewer'],
      rowColumn: 'organization_id',
      rowField: 'orgId',
      expiresAt: 'expires_at',
      now: expect.any(Number),
      tenantColumn: 'organization_id',
      tenantValue: 'o1',
    });
    expect(
      compileWhere(
        { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: ['viewer'] },
        {
          subject: { principal: null, context: {} },
          memberships: {
            tenant: {
              table: 'organization_members',
              user: 'user_id',
              role: 'role',
              tenant: 'organization_id',
            },
          },
        },
      ),
    ).toEqual({ kind: 'never' });
  });

  it('collapses and-of-always and or-of-never', () => {
    expect(
      compileWhere({
        op: 'and',
        conditions: [
          { op: 'eq', field: '_', value: true },
          { op: 'eq', field: '_', value: true },
        ],
      }),
    ).toEqual({ kind: 'always' });
    expect(
      compileWhere({
        op: 'or',
        conditions: [
          { op: 'eq', field: '_', value: false },
          { op: 'in', field: 'id', value: [] },
        ],
      }),
    ).toEqual({ kind: 'never' });
  });

  it('short-circuits and / or / not against never and always', () => {
    expect(
      compileWhere({
        op: 'and',
        conditions: [
          { op: 'eq', field: 'authorId', value: 'u1' },
          { op: 'eq', field: '_', value: false },
        ],
      }),
    ).toEqual({ kind: 'never' });
    expect(
      compileWhere({
        op: 'or',
        conditions: [
          { op: 'eq', field: 'authorId', value: 'u1' },
          { op: 'eq', field: '_', value: true },
        ],
      }),
    ).toEqual({ kind: 'always' });
    expect(
      compileWhere({
        op: 'not',
        condition: { op: 'eq', field: '_', value: false },
      }),
    ).toEqual({ kind: 'always' });
  });

  it('compiles not, compounds and more memberOf mapping cases', () => {
    expect(
      compileWhere({
        op: 'not',
        condition: { op: 'eq', field: 'authorId', value: 'u1' },
      }),
    ).toEqual({
      kind: 'or',
      items: [
        {
          kind: 'not',
          item: { kind: 'compare', op: 'eq', field: 'authorId', value: 'u1' },
        },
        { kind: 'isNull', field: 'authorId', negated: false },
      ],
    });
    expect(
      compileWhere({
        op: 'and',
        conditions: [
          { op: 'eq', field: 'authorId', value: 'u1' },
          { op: 'ne', field: 'status', value: 'draft' },
        ],
      }),
    ).toEqual({
      kind: 'and',
      items: [
        { kind: 'compare', op: 'eq', field: 'authorId', value: 'u1' },
        { kind: 'compare', op: 'ne', field: 'status', value: 'draft' },
      ],
    });
    expect(
      compileWhere(
        { op: 'memberOf', scope: 'team', field: 'teamId', roles: ['lead'] },
        {
          subject: sub({ id: 'u1', tenant: 'o1' }),
          memberships: {
            team: {
              table: 'team_members',
              user: 'user_id',
              role: 'role',
              team: 'team_id',
              tenant: 'organization_id',
            },
          },
        },
      ),
    ).toMatchObject({
      kind: 'exists',
      table: 'team_members',
      rowColumn: 'team_id',
      tenantColumn: 'organization_id',
      tenantValue: 'o1',
    });
    expect(
      compileWhere(
        {
          op: 'memberOf',
          scope: 'resource',
          field: 'id',
          roles: ['editor'],
        },
        {
          subject: sub({ id: 'u1' }),
          memberships: {
            resource: {
              document: {
                table: 'document_members',
                user: 'user_id',
                role: 'role',
                id: 'document_id',
              },
            },
          },
        },
      ),
    ).toEqual({ kind: 'never' });
    expect(
      compileWhere(
        { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: ['viewer'] },
        {
          subject: sub({ id: 'u1' }),
          memberships: {
            tenant: {
              table: 'organization_members',
              user: 'user_id',
              role: 'role',
            },
          },
        },
      ),
    ).toEqual({ kind: 'never' });
  });

  it('skips memberships that lack the scoped identifier', () => {
    const incomplete = sub({
      id: 'u1',
      memberships: [
        { roles: ['lead'] },
        { roles: ['editor'] },
        { tenant: 'o1', team: 't1', roles: ['lead'] },
      ],
    });
    expect(
      compileWhere(
        { op: 'memberOf', scope: 'team', field: 'teamId', roles: ['lead'] },
        { subject: incomplete, now },
      ),
    ).toEqual({ kind: 'compare', op: 'eq', field: 'teamId', value: 't1' });
    expect(
      compileWhere(
        {
          op: 'memberOf',
          scope: 'resource',
          field: 'id',
          roles: ['editor'],
        },
        { subject: incomplete, now },
      ),
    ).toEqual({ kind: 'never' });
  });

  it('resolves nested subject paths and defaults now', () => {
    const who = sub({ id: 'u1', orgId: 'o9' }, { deep: { n: 1 } });
    expect(
      compileWhere(
        { op: 'eq', field: 'orgId', value: { ref: 'principal.orgId' } },
        { subject: who },
      ),
    ).toEqual({ kind: 'compare', op: 'eq', field: 'orgId', value: 'o9' });
    expect(
      compileWhere(
        { op: 'eq', field: 'n', value: { ref: 'context.deep.n' } },
        { subject: who },
      ),
    ).toEqual({ kind: 'compare', op: 'eq', field: 'n', value: 1 });
    expect(
      compileWhere(
        { op: 'in', field: 'id', value: { ref: 'context.missing' } },
        { subject: who },
      ),
    ).toEqual({ kind: 'never' });
    expect(
      compileWhere(
        {
          op: 'memberOf',
          scope: 'resource',
          field: 'id',
          roles: ['editor'],
          resource: 'document',
        },
        {
          subject: sub({
            id: 'u1',
            memberships: [
              { on: { resource: 'document', id: 'd1' }, roles: ['editor'] },
            ],
          }),
          memberships: {
            resource: {
              document: {
                table: 'document_members',
                user: 'user_id',
                role: 'role',
                id: 'document_id',
              },
            },
          },
        },
      ),
    ).toMatchObject({
      kind: 'exists',
      table: 'document_members',
      rowColumn: 'document_id',
    });
  });

  it('fails closed when memberOf matches nothing', () => {
    expect(
      compileWhere(
        {
          op: 'memberOf',
          scope: 'resource',
          field: 'id',
          roles: ['editor'],
          resource: 'document',
        },
        { subject: sub({ id: 'u1', memberships: [] }), now },
      ),
    ).toEqual({ kind: 'never' });
  });

  it('rejects forbidden field keys', () => {
    expect(() =>
      compileWhere({ op: 'eq', field: 'constructor', value: 'x' }),
    ).toThrow(/forbidden/);
  });
  it('keys parent hops by resource in the in-list and exists forms', () => {
    const condition = {
      op: 'memberOf',
      scope: 'resource',
      resource: 'doc',
      field: 'id',
      roles: ['editor'],
      parents: [{ field: 'folderId', resource: 'folder' }],
    } as const;
    const holder: Subject = {
      principal: {
        id: 'u1',
        memberships: [
          { on: { resource: 'folder', id: 'f1' }, roles: ['editor'] },
          { on: { resource: 'project', id: 'p1' }, roles: ['editor'] },
        ],
      },
      context: {},
    };
    expect(compileWhere(condition, { subject: holder })).toEqual({
      kind: 'compare',
      op: 'eq',
      field: 'folderId',
      value: 'f1',
    });
    const table = {
      table: 'members',
      user: 'user_id',
      role: 'role',
      id: 'on_id',
    };
    expect(
      compileWhere(condition, {
        subject: holder,
        now: 1,
        memberships: { resource: { doc: table } },
      }),
    ).toMatchObject({ kind: 'exists', rowField: 'id' });
    const shared = { ...table, resource: 'on_type' };
    expect(
      compileWhere(condition, {
        subject: holder,
        now: 1,
        memberships: { resource: { doc: shared, folder: shared } },
      }),
    ).toMatchObject({
      kind: 'or',
      items: [
        { kind: 'exists', rowField: 'id', resourceValue: 'doc' },
        { kind: 'exists', rowField: 'folderId', resourceValue: 'folder' },
      ],
    });
  });

  it('negates every compiled node kind with SQL NULL in mind', () => {
    expect(
      compileWhere({ op: 'not', condition: { op: 'or', conditions: [] } }),
    ).toEqual({
      kind: 'always',
    });
    expect(
      compileWhere({ op: 'not', condition: { op: 'and', conditions: [] } }),
    ).toEqual({ kind: 'never' });
    expect(
      compileWhere({
        op: 'not',
        condition: {
          op: 'and',
          conditions: [
            { op: 'eq', field: 'a', value: 1 },
            { op: 'isNull', field: 'b', value: true },
          ],
        },
      }),
    ).toEqual({
      kind: 'or',
      items: [
        {
          kind: 'or',
          items: [
            {
              kind: 'not',
              item: { kind: 'compare', op: 'eq', field: 'a', value: 1 },
            },
            { kind: 'isNull', field: 'a', negated: false },
          ],
        },
        { kind: 'isNull', field: 'b', negated: true },
      ],
    });
    expect(
      compileWhere({
        op: 'not',
        condition: {
          op: 'or',
          conditions: [
            { op: 'isNull', field: 'a', value: true },
            { op: 'isNull', field: 'b', value: true },
          ],
        },
      }),
    ).toEqual({
      kind: 'and',
      items: [
        { kind: 'isNull', field: 'a', negated: true },
        { kind: 'isNull', field: 'b', negated: true },
      ],
    });
    expect(
      compileWhere({
        op: 'not',
        condition: { op: 'not', condition: { op: 'eq', field: 'a', value: 1 } },
      }),
    ).toEqual({
      kind: 'and',
      items: [
        { kind: 'compare', op: 'eq', field: 'a', value: 1 },
        { kind: 'isNull', field: 'a', negated: true },
      ],
    });
    const member: Subject = {
      principal: {
        id: 'u1',
        tenant: 'o1',
        memberships: [{ tenant: 'o1', roles: [] }],
      },
      context: {},
    };
    expect(
      compileWhere(
        {
          op: 'not',
          condition: {
            op: 'memberOf',
            scope: 'tenant',
            field: 'orgId',
            roles: [],
          },
        },
        {
          subject: member,
          memberships: {
            tenant: { table: 'm', user: 'u', role: 'r', tenant: 't' },
          },
        },
      ),
    ).toMatchObject({ kind: 'not', item: { kind: 'exists', roles: [] } });
    expect(
      compileWhere(
        { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: [] },
        { subject: member },
      ),
    ).toEqual({ kind: 'compare', op: 'eq', field: 'orgId', value: 'o1' });
  });

  it('fails closed on invalid dates, null values and unknown operators', () => {
    expect(
      compileWhere({ op: 'gt', field: 'due', value: { date: 'not a date' } }),
    ).toEqual({ kind: 'never' });
    expect(compileWhere({ op: 'eq', field: 'a', value: null })).toEqual({
      kind: 'never',
    });
    expect(() =>
      compileWhere({ op: 'nope', field: 'a' } as unknown as Condition),
    ).toThrow(/unknown condition/);
  });

  it('compiles a bare parent hop against the row table without a resource key', () => {
    const holder: Subject = {
      principal: {
        id: 'u1',
        memberships: [
          { on: { resource: 'folder', id: 'f1' }, roles: ['editor'] },
        ],
      },
      context: {},
    };
    expect(
      compileWhere(
        {
          op: 'memberOf',
          scope: 'resource',
          resource: 'doc',
          field: 'id',
          roles: ['editor'],
          parents: ['folderId'],
        },
        {
          subject: holder,
          now: 1,
          memberships: {
            resource: {
              doc: {
                table: 'members',
                user: 'u',
                role: 'r',
                id: 'on_id',
                resource: 'kind',
              },
            },
          },
        },
      ),
    ).toMatchObject({
      kind: 'or',
      items: [
        { kind: 'exists', rowField: 'id', resourceValue: 'doc' },
        { kind: 'exists', rowField: 'folderId' },
      ],
    });
  });
});
