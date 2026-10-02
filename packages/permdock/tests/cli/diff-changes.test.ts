import { describe, expect, it } from 'vitest';

import type { CatalogDiff } from '../../src/cli/diff.ts';
import type {
  CatalogDelegation,
  CatalogDocument,
  CatalogGrant,
} from '../../src/cli/types.ts';

import { diffCatalogs } from '../../src/cli/diff.ts';

function catalog(
  overrides: Partial<CatalogDocument> & {
    readonly grants: readonly CatalogGrant[];
  },
): CatalogDocument {
  return {
    $schema: 'https://permdock.dev/schemas/catalog-v1.json',
    version: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    generator: 'test',
    resources: {},
    permissions: [
      {
        key: 'post.read',
        scope: 'post:read',
        resource: 'post',
        action: 'read',
        arity: 'instance',
        meta: {},
        usages: [],
      },
    ],
    roles: [{ key: 'member' }],
    ...overrides,
  };
}

function grant(overrides: Partial<CatalogGrant>): CatalogGrant {
  return {
    permission: 'post.read',
    effect: 'allow',
    role: 'member',
    to: { role: 'member' },
    scope: 'global',
    ...overrides,
  };
}

function compare(
  before: readonly CatalogGrant[],
  after: readonly CatalogGrant[],
  extra: {
    readonly a?: Partial<CatalogDocument>;
    readonly b?: Partial<CatalogDocument>;
  } = {},
): CatalogDiff {
  return diffCatalogs(
    {
      source: 'a.json',
      catalog: catalog({ grants: before, ...extra.a }),
      policy: undefined,
    },
    {
      source: 'b.json',
      catalog: catalog({ grants: after, ...extra.b }),
      policy: undefined,
    },
  );
}

function changesOf(diff: CatalogDiff): readonly string[] {
  return diff.grants?.changed.flatMap((change) => change.changes) ?? [];
}

function kinds(diff: CatalogDiff): readonly string[] {
  return diff.breaking.map((change) => change.kind);
}

const open = grant({});
const eq = { field: 'status', op: 'eq', value: 'draft' };
const neq = { field: 'status', op: 'eq', value: 'published' };

describe('grant change descriptions', () => {
  it('names a where, check, approval or limit that was added, removed or changed', () => {
    const conditioned = grant({
      where: eq,
      check: eq,
      approval: 'human',
      limit: { count: 1, per: '1d' },
    });
    const other = grant({
      where: neq,
      check: neq,
      approval: { by: { role: 'admin' } },
      limit: { count: 2, per: '1d' },
    });
    expect(changesOf(compare([open], [conditioned]))).toEqual([
      'where added',
      'check added',
      'approval added',
      'limit added',
    ]);
    expect(kinds(compare([open], [conditioned]))).toEqual(['allow-narrowed']);
    expect(changesOf(compare([conditioned], [open]))).toEqual([
      'where removed',
      'check removed',
      'approval removed',
      'limit removed',
    ]);
    expect(kinds(compare([conditioned], [open]))).toEqual([]);
    expect(changesOf(compare([conditioned], [other]))).toEqual([
      'where changed',
      'check changed',
      'approval changed',
      'limit changed',
    ]);
  });

  it('tells a narrowed field list from a widened one', () => {
    const two = grant({ fields: ['title', 'body'] });
    const one = grant({ fields: ['title'] });
    expect(changesOf(compare([open], [one]))).toEqual(['fields narrowed']);
    expect(changesOf(compare([one], [open]))).toEqual(['fields widened']);
    expect(changesOf(compare([two], [one]))).toEqual(['fields narrowed']);
    expect(changesOf(compare([one], [two]))).toEqual(['fields widened']);
  });

  it('tells a narrowed validity window from a widened one', () => {
    const later = grant({ validity: { from: 200 } });
    const earlier = grant({ validity: { from: 100 } });
    const shorter = grant({ validity: { from: 100, until: 900 } });
    expect(changesOf(compare([open], [later]))).toEqual(['validity narrowed']);
    expect(changesOf(compare([later], [open]))).toEqual(['validity widened']);
    expect(changesOf(compare([later], [earlier]))).toEqual([
      'validity widened',
    ]);
    expect(changesOf(compare([earlier], [later]))).toEqual([
      'validity narrowed',
    ]);
    expect(changesOf(compare([earlier], [shorter]))).toEqual([
      'validity narrowed',
    ]);
    expect(changesOf(compare([later], [shorter]))).toEqual([
      'validity narrowed',
    ]);
  });

  it('reports purpose, name and portability changes', () => {
    const named = grant({
      name: 'readers',
      purpose: ['support'],
      portable: false,
    });
    const renamed = grant({ name: 'viewers', purpose: ['billing'] });
    expect(changesOf(compare([named], [renamed]))).toEqual([
      'purpose changed',
      'name changed',
      'portable',
    ]);
    expect(changesOf(compare([renamed], [named]))).toEqual([
      'purpose changed',
      'name changed',
      'portable: false',
    ]);
    expect(kinds(compare([renamed], [named]))).toEqual(['allow-narrowed']);
    expect(kinds(compare([named], [renamed]))).toEqual(['allow-narrowed']);
  });

  it('describes top-level, scoped and resource grants and a changed deny', () => {
    const top = grant({ role: null, to: { authenticated: true } });
    const scoped = grant({ scope: 'tenant' });
    const onResource = grant({ scope: { resource: 'post' } });
    const diff = compare([top, scoped, onResource], []);
    expect(diff.breaking.map((change) => change.detail)).toEqual([
      'allow post.read (top-level) removed',
      'allow post.read (role member in tenant) removed',
      'allow post.read (role member on post) removed',
    ]);
    const deny = grant({ effect: 'deny', where: eq });
    const looser = grant({ effect: 'deny' });
    expect(compare([deny], [looser]).breaking).toEqual([
      {
        kind: 'deny-changed',
        permission: 'post.read',
        role: 'member',
        detail: 'deny post.read (role member): where removed',
      },
    ]);
    expect(kinds(compare([deny], []))).toEqual([]);
  });

  it('does not list an allow removed with its role or permission', () => {
    const diff = compare([open], [], {
      b: { roles: [], permissions: [] },
    });
    expect(kinds(diff)).toEqual(['permission-removed', 'role-removed']);
    const scoped = compare([grant({ scope: 'tenant' })], [], {
      a: { scopes: [{ name: 'tenant', key: 'tenantId' }] },
    });
    expect(kinds(scoped)).toEqual(['scope-removed', 'allow-removed']);
  });

  it('skips the grants and delegations sections without both grant lists', () => {
    const a = catalog({ grants: [open] });
    const { grants: _grants, ...withoutGrants } = a;
    const diff = diffCatalogs(
      { source: 'a.json', catalog: a, policy: undefined },
      { source: 'b.json', catalog: withoutGrants, policy: undefined },
    );
    expect(diff.grants).toBeUndefined();
    expect(diff.delegations).toBeUndefined();
    expect(diff.a).toEqual({ source: 'a.json' });
  });
});

describe('delegation change descriptions', () => {
  const toKind: CatalogDelegation = {
    from: { role: 'member' },
    to: { kind: 'eve' },
    permissions: ['post.read', 'post.update'],
  };
  const toOne: CatalogDelegation = {
    ...toKind,
    to: { kind: 'eve', id: 'agent-1' },
    validity: { until: 900 },
  };

  it('names the actor and lists gained keys and a widened window as safe', () => {
    const wider: CatalogDelegation = {
      ...toOne,
      permissions: ['post.read', 'post.update', 'post.delete'],
      validity: {},
    };
    const diff = compare([open], [open], {
      a: { delegations: [toOne] },
      b: { delegations: [wider] },
    });
    expect(diff.delegations?.changed[0]?.changes).toEqual([
      'permissions added: post.delete',
      'validity widened',
    ]);
    expect(diff.breaking).toEqual([]);
    const removed = compare([open], [open], { a: { delegations: [toOne] } });
    expect(removed.breaking[0]?.detail).toBe(
      'delegation {"role":"member"} → eve agent-1 (post.read, post.update) removed',
    );
  });

  it('keeps an unchanged delegation out of every list', () => {
    const diff = compare([open], [open], {
      a: { delegations: [toKind] },
      b: { delegations: [toKind] },
    });
    expect(diff.delegations).toEqual({ added: [], removed: [], changed: [] });
  });
});
