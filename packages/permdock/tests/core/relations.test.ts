import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { RelationSource } from '../../src/core/interfaces.ts';

import { fromSnapshot } from '../../src/core/from-snapshot.ts';
import { relation } from '../../src/core/grantee.ts';
import {
  mergeHostedGrants,
  parsePolicyDocument,
} from '../../src/core/hosted.ts';
import { mayAccess } from '../../src/core/may-access.ts';
import { createPermDock } from '../../src/core/permdock.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { allow, definePolicy, deny, role } from '../../src/core/policy.ts';
import { memoryRelations } from '../../src/core/relations.ts';
import { testRelationSource } from '../../src/testing/conformance.ts';

const Folder = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  restricted: z.boolean(),
  ownerId: z.string(),
  orgId: z.string().optional(),
});
const Doc = z.object({
  id: z.string(),
  folderId: z.string(),
  ownerId: z.string(),
});
const Employee = z.object({
  id: z.string(),
  managerId: z.string().nullable(),
});
const Account = z.object({
  id: z.string(),
  delegateId: z.string().nullable(),
  delegateFrom: z.string().nullable(),
  delegateUntil: z.string().nullable(),
});

const permissions = definePermissions({
  doc: resource(Doc, {
    actions: ['read', 'update', 'archive'],
    parent: { field: 'folderId', resource: 'folder' },
    relations: { owner: 'ownerId' },
  }),
  folder: resource(Folder, {
    actions: ['read', 'share'],
    parent: { field: 'parentId', resource: 'folder' },
    relations: {
      editor: { edge: 'folder_editors' },
      viewer: { edge: 'folder_viewers', expiresAt: 'expires_at' },
      owner: 'ownerId',
      org: { field: 'orgId', memberOf: 'org' },
    },
    restricted: 'restricted',
  }),
  employee: resource(Employee, {
    actions: ['review'],
    parent: { field: 'managerId', resource: 'employee' },
    relations: { manager: { principal: 'managerId' } },
  }),
  account: resource(Account, {
    actions: ['act'],
    relations: {
      delegate: {
        principal: 'delegateId',
        period: { startsAt: 'delegateFrom', expiresAt: 'delegateUntil' },
      },
    },
  }),
});

const viewerThrough = relation(permissions.folder, 'viewer', {
  through: 'parent',
  depth: 3,
});

const policy = definePolicy(permissions, {
  scopes: { org: { key: 'orgId' } },
  roles: [role('auditor', [allow(permissions.folder.read)])],
  grants: [
    allow(permissions.doc.read, { to: relation(permissions.doc, 'owner') }),
    allow(permissions.doc.read, { to: viewerThrough }),
    allow(permissions.doc.update, {
      to: relation(permissions.folder, 'editor', {
        through: 'parent',
        depth: 3,
      }),
    }),
    allow(permissions.doc.archive, {
      to: [
        relation(permissions.doc, 'owner'),
        relation(permissions.folder, 'editor', { through: 'parent', depth: 3 }),
      ],
    }),
    allow(permissions.folder.read, { to: viewerThrough }),
    allow(permissions.folder.share, {
      to: relation(permissions.folder, 'owner', {
        through: 'parent',
        depth: 3,
      }),
    }),
    allow(permissions.employee.review, {
      to: relation(permissions.employee, 'manager', {
        through: 'parent',
        depth: 4,
      }),
    }),
    allow(permissions.account.act, {
      to: relation(permissions.account, 'delegate'),
    }),
  ],
  subject: (user: { readonly id: string; readonly roles?: string[] }) => ({
    id: user.id,
    roles: user.roles ?? [],
  }),
});

// root ─ eng ─ platform ─ deep ─ deeper
//      └ hr (restricted) ─ payroll
const folders = [
  { id: 'root', parentId: null, restricted: false, ownerId: 'olga' },
  { id: 'eng', parentId: 'root', restricted: false, ownerId: 'olga' },
  { id: 'platform', parentId: 'eng', restricted: false, ownerId: 'olga' },
  { id: 'deep', parentId: 'platform', restricted: false, ownerId: 'olga' },
  { id: 'deeper', parentId: 'deep', restricted: false, ownerId: 'olga' },
  { id: 'hr', parentId: 'root', restricted: true, ownerId: 'olga' },
  { id: 'payroll', parentId: 'hr', restricted: false, ownerId: 'olga' },
];
const doc = (id: string, folderId: string, ownerId = 'nobody') => ({
  id,
  folderId,
  ownerId,
});

const source = memoryRelations(permissions, {
  rows: { folder: folders },
  edges: {
    folder: {
      viewer: [
        { id: 'root', principal: 'vera' },
        { id: 'hr', principal: 'hana' },
        { id: 'eng', principal: 'ed', expiresAt: 1000 },
      ],
      editor: [{ id: 'eng', principal: 'edith' }],
    },
  },
});

function dock(id: string, relations: RelationSource | null = source) {
  return createPermDock(
    policy,
    { id },
    relations === null ? {} : { relations },
  );
}

describe('relationship graph', () => {
  it('reaches a document through viewers on its folder ancestors', async () => {
    const vera = await dock('vera');
    expect(vera.can(permissions.doc.read, doc('d1', 'platform'))).toBe(true);
    expect(vera.can(permissions.folder.read, folders[2])).toBe(true);
    const stranger = await dock('sam');
    expect(
      stranger.decide(permissions.doc.read, doc('d1', 'platform')),
    ).toMatchObject({
      outcome: 'denied',
    });
  });

  it('keeps ancestor grants out of a restricted branch but not grants on it', async () => {
    const vera = await dock('vera');
    expect(vera.can(permissions.doc.read, doc('d2', 'payroll'))).toBe(false);
    expect(vera.can(permissions.folder.read, folders[5])).toBe(false);
    const hana = await dock('hana');
    expect(hana.can(permissions.doc.read, doc('d2', 'payroll'))).toBe(true);
    expect(hana.can(permissions.folder.read, folders[5])).toBe(true);
    expect(hana.can(permissions.doc.read, doc('d3', 'eng'))).toBe(false);
  });

  it('denies with relation-depth past depth, and grants a holder within it', async () => {
    const vera = await dock('vera');
    const decision = vera.decide(permissions.doc.read, doc('d4', 'deeper'));
    expect(decision.outcome).toBe('denied');
    expect(
      decision.outcome === 'denied' &&
        decision.denials.some((item) => item.reason === 'relation-depth'),
    ).toBe(true);
    const edith = await dock('edith');
    expect(edith.can(permissions.doc.update, doc('d4', 'deeper'))).toBe(true);
  });

  it('denies a cycle with relation-depth', async () => {
    const cyclic = memoryRelations(permissions, {
      rows: {
        folder: [
          { id: 'a', parentId: 'b', restricted: false, ownerId: 'x' },
          { id: 'b', parentId: 'a', restricted: false, ownerId: 'x' },
        ],
      },
      edges: { folder: { viewer: [{ id: 'b', principal: 'vera' }] } },
    });
    const vera = await dock('vera', cyclic);
    const decision = vera.decide(permissions.doc.read, doc('d5', 'a'));
    expect(decision).toMatchObject({
      outcome: 'denied',
      denials: expect.arrayContaining([
        expect.objectContaining({ reason: 'relation-depth' }),
      ]),
    });
  });

  it('ignores an expired edge', async () => {
    const ed = await dock('ed');
    expect(ed.can(permissions.doc.read, doc('d6', 'eng'))).toBe(false);
    expect(ed.can(permissions.doc.read, doc('d6', 'eng'), { now: 999 })).toBe(
      true,
    );
  });

  it('denies with relation-unavailable without a source, on a throw and on an unloaded Promise', async () => {
    const none = await dock('vera', null);
    expect(none.decide(permissions.doc.read, doc('d1', 'eng'))).toMatchObject({
      outcome: 'denied',
      denials: expect.arrayContaining([
        expect.objectContaining({ reason: 'relation-unavailable' }),
      ]),
    });
    const throwing = await dock('vera', {
      ancestors() {
        throw new Error('down');
      },
      related() {
        throw new Error('down');
      },
    });
    expect(throwing.can(permissions.doc.read, doc('d1', 'eng'))).toBe(false);
    const slow: RelationSource = {
      ancestors: (query) => Promise.resolve(source.ancestors(query)),
      related: (query) => Promise.resolve(source.related(query)),
    };
    const vera = await dock('vera', slow);
    expect(vera.can(permissions.doc.read, doc('d1', 'eng'))).toBe(false);
    await vera.loadRelations(permissions.doc.read, [doc('d1', 'eng')]);
    expect(vera.can(permissions.doc.read, doc('d1', 'eng'))).toBe(true);
    const rejecting = await dock('vera', {
      ancestors: () => Promise.reject(new Error('down')),
      related: () => Promise.reject(new Error('down')),
    });
    await rejecting.loadRelations(permissions.doc.read, [doc('d1', 'eng')]);
    expect(rejecting.can(permissions.doc.read, doc('d1', 'eng'))).toBe(false);
  });

  it('rejects malformed source answers', async () => {
    // SAFETY: deliberately malformed source answers, to exercise fail-closed validation.
    const junk = await dock('vera', {
      ancestors: () => ({ ancestors: [{ id: 7 }] }) as never,
      related: () => [{ principal: 'vera' }] as never,
    });
    expect(junk.decide(permissions.doc.read, doc('d1', 'eng'))).toMatchObject({
      outcome: 'denied',
      denials: expect.arrayContaining([
        expect.objectContaining({ reason: 'relation-unavailable' }),
      ]),
    });
  });

  it('caches per instance, never across instances', async () => {
    const related = vi.fn<RelationSource['related']>((query) =>
      source.related(query),
    );
    const ancestors = vi.fn<RelationSource['ancestors']>((query) =>
      source.ancestors(query),
    );
    const counted: RelationSource = { ancestors, related };
    const first = await dock('vera', counted);
    first.can(permissions.doc.read, doc('d1', 'platform'));
    first.can(permissions.doc.read, doc('d7', 'platform'));
    first.tenant('acme').can(permissions.doc.read, doc('d8', 'platform'));
    const calls = related.mock.calls.length;
    expect(ancestors).toHaveBeenCalledTimes(1);
    const second = await dock('vera', counted);
    second.can(permissions.doc.read, doc('d1', 'platform'));
    expect(related.mock.calls.length).toBe(calls * 2);
  });

  it('intersects an array of relations', async () => {
    const edith = await dock('edith');
    expect(edith.can(permissions.doc.archive, doc('d9', 'eng', 'edith'))).toBe(
      true,
    );
    expect(edith.can(permissions.doc.archive, doc('d9', 'eng', 'owen'))).toBe(
      false,
    );
  });

  it('follows reporting lines to skip-level managers', async () => {
    const people = memoryRelations(permissions, {
      rows: {
        employee: [
          { id: 'ceo', managerId: null },
          { id: 'vp', managerId: 'ceo' },
          { id: 'lead', managerId: 'vp' },
          { id: 'dev', managerId: 'lead' },
        ],
      },
    });
    const ceo = await dock('ceo', people);
    expect(
      ceo.can(permissions.employee.review, { id: 'dev', managerId: 'lead' }),
    ).toBe(true);
    const lead = await dock('lead', people);
    expect(
      lead.can(permissions.employee.review, { id: 'vp', managerId: 'ceo' }),
    ).toBe(false);
  });

  it('bounds a principal relation by its period', async () => {
    const dana = await dock('dana');
    const account = {
      id: 'a1',
      delegateId: 'dana',
      delegateFrom: '2026-01-01T00:00:00Z',
      delegateUntil: '2026-02-01T00:00:00Z',
    };
    const inside = Date.parse('2026-01-15T00:00:00Z') / 1000;
    const after = Date.parse('2026-03-01T00:00:00Z') / 1000;
    expect(dana.can(permissions.account.act, account, { now: inside })).toBe(
      true,
    );
    expect(dana.can(permissions.account.act, account, { now: after })).toBe(
      false,
    );
  });

  it('lets a graph deny fail closed when the graph cannot answer', async () => {
    const guarded = definePolicy(permissions, {
      grants: [
        allow(permissions.doc.read, { to: relation(permissions.doc, 'owner') }),
        deny(permissions.doc.read, {
          to: relation(permissions.folder, 'viewer', {
            through: 'parent',
            depth: 3,
          }),
        }),
      ],
      subject: (user: { readonly id: string }) => ({ id: user.id, roles: [] }),
    });
    const owner = await createPermDock(guarded, { id: 'owen' });
    expect(
      owner.decide(permissions.doc.read, doc('d1', 'eng', 'owen')),
    ).toMatchObject({
      outcome: 'denied',
      denials: [expect.objectContaining({ reason: 'relation-unavailable' })],
    });
    const loaded = await createPermDock(
      guarded,
      { id: 'owen' },
      { relations: source },
    );
    expect(loaded.can(permissions.doc.read, doc('d1', 'eng', 'owen'))).toBe(
      true,
    );
  });

  it('keeps the graph out of snapshots but in where()', async () => {
    const vera = await dock('vera');
    const snapshot = vera.snapshot();
    const grant =
      'grants' in snapshot
        ? snapshot.grants.find(
            (item) => item.permission === 'doc.read' && item.portable === false,
          )
        : undefined;
    expect(grant).toBeDefined();
    expect(grant?.where).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain('"related"');
    // SAFETY: the instance has no signer, so snapshot() returned an unsigned Snapshot.
    const client = fromSnapshot(snapshot as never);
    expect(client.decide(permissions.doc.read, doc('d1', 'eng'))).toMatchObject(
      {
        outcome: 'denied',
        denials: expect.arrayContaining([
          expect.objectContaining({ reason: 'opaque-condition' }),
        ]),
      },
    );
    const where = vera.where(permissions.doc.read);
    expect(where.partial).toBe(false);
    expect(JSON.stringify(where.condition)).toContain('"related"');
    expect(where.resources?.get('doc')?.name).toBe('doc');
    expect(Object.keys(where)).not.toContain('resources');
    expect(mayAccess(policy, { id: 'vera' }, permissions.doc.read)).toBe(true);
  });

  it('rejects graph grants that cannot reach their resource', () => {
    const subject = (user: { readonly id: string }) => ({
      id: user.id,
      roles: [],
    });
    expect(() =>
      definePolicy(permissions, {
        grants: [
          allow(permissions.doc.read, {
            to: relation(permissions.folder, 'viewer'),
          }),
        ],
        subject,
      }),
    ).toThrow(/add through: 'parent'/);
    expect(() =>
      definePolicy(permissions, {
        grants: [
          allow(permissions.account.act, {
            to: relation(permissions.account, 'delegate', {
              through: 'parent',
            }),
          }),
        ],
        subject,
      }),
    ).toThrow(/needs account to parent itself/);
    expect(() =>
      definePolicy(permissions, {
        grants: [
          allow(permissions.employee.review, {
            to: relation(permissions.folder, 'viewer', { through: 'parent' }),
          }),
        ],
        subject,
      }),
    ).toThrow(/has no parent on folder/);
    expect(() => relation(permissions.folder, 'viewer', { depth: 2 })).toThrow(
      /depth needs through/,
    );
    expect(() =>
      relation(permissions.folder, 'viewer', { through: 'parent', depth: 33 }),
    ).toThrow(/0 to 32/);
    expect(
      relation(permissions.folder, 'viewer', { through: 'parent' }),
    ).toEqual({
      kind: 'relation',
      resource: 'folder',
      relation: 'viewer',
      through: 'parent',
    });
  });

  it('whoCan lists shares, relations and role holders, and says when it is incomplete', async () => {
    const memberships = {
      membershipsFor: () => [],
      list: ({ scope, id }: { readonly scope: string; readonly id: string }) =>
        scope === 'org' && id === 'acme'
          ? [
              {
                principal: { id: 'rita' },
                membership: { scope: 'org', id: 'acme', roles: ['reader'] },
              },
            ]
          : [],
    };
    const scoped = definePolicy(permissions, {
      scopes: { org: { key: 'orgId' } },
      roles: [role('reader', [allow(permissions.folder.read)], { on: 'org' })],
      grants: [allow(permissions.folder.read, { to: viewerThrough })],
      subject: (user: { readonly id: string }) => ({ id: user.id, roles: [] }),
    });
    const owner = await createPermDock(
      scoped,
      { id: 'olga' },
      { relations: source, memberships },
    );
    const platform = { ...folders[2], orgId: 'acme' };
    const result = await owner.whoCan(permissions.folder.read, platform);
    expect(result.complete).toBe(true);
    expect(result.holders.map((item) => item.principal.id)).toEqual([
      'rita',
      'vera',
    ]);
    expect(result.holders[1]?.via).toEqual([
      { kind: 'share', resource: 'folder', relation: 'viewer', id: 'root' },
    ]);
    expect(result.holders[0]?.via[0]).toMatchObject({
      kind: 'role',
      role: 'reader',
    });
    const hr = await owner.whoCan(permissions.folder.read, {
      ...folders[5],
      orgId: 'acme',
    });
    expect(hr.holders.map((item) => item.principal.id)).toEqual([
      'hana',
      'rita',
    ]);
    const global = await (
      await dock('olga')
    ).whoCan(permissions.folder.read, folders[2]);
    expect(global.complete).toBe(false);
    const unlisted = await createPermDock(
      scoped,
      { id: 'olga' },
      { relations: source, memberships: { membershipsFor: () => [] } },
    );
    expect(
      (await unlisted.whoCan(permissions.folder.read, platform)).complete,
    ).toBe(false);
    const owners = await (
      await dock('olga')
    ).whoCan(permissions.doc.read, doc('d1', 'eng', 'owen'));
    expect(owners.holders.map((item) => item.principal.id)).toEqual([
      'owen',
      'vera',
    ]);
    expect(owners.holders[0]?.via).toEqual([
      { kind: 'relation', resource: 'doc', relation: 'owner', id: 'd1' },
    ]);
  });
});

describe('hosted graph grants', () => {
  it('accepts a bounded walk on the permission resource and drops an unbounded one', async () => {
    const hostable = definePolicy(permissions, {
      subject: (user: { readonly id: string }) => ({ id: user.id, roles: [] }),
      hostable: [permissions.folder.read],
    });
    const grant = (id: string, extra: Record<string, unknown>) => ({
      id,
      permission: 'folder.read',
      to: {
        kind: 'relation',
        resource: 'folder',
        relation: 'viewer',
        ...extra,
      },
    });
    const merged = mergeHostedGrants(
      hostable,
      parsePolicyDocument({
        v: 1,
        id: 'doc',
        fingerprint: 'fp',
        catalog: 'cat',
        issuedAt: 1,
        grants: [
          grant('ok', { through: 'parent', depth: 3 }),
          grant('deep', { through: 'parent', depth: 99 }),
          grant('sideways', { through: 'sideways' }),
        ],
      }),
    );
    expect(merged.dropped.map((item) => [item.grant, item.reason])).toEqual([
      ['deep', 'unknown-grantee'],
      ['sideways', 'unknown-grantee'],
    ]);
    const vera = await createPermDock(
      merged.policy,
      { id: 'vera' },
      { relations: source },
    );
    expect(vera.can(permissions.folder.read, folders[2])).toBe(true);
  });
});

describe('memoryRelations conformance', () => {
  testRelationSource(source, {
    objects: [
      { resource: 'folder', id: 'deeper', relation: 'viewer' },
      { resource: 'folder', id: 'payroll', relation: 'viewer' },
      { resource: 'folder', id: 'root', relation: 'viewer' },
      { resource: 'folder', id: 'eng', relation: 'owner' },
    ],
    expect: {
      ancestors: {
        'folder:deeper': ['deep', 'platform', 'eng', 'root'],
        'folder:payroll': ['hr'],
        'folder:root': [],
      },
      holders: {
        'folder:root#viewer': ['vera'],
        'folder:eng#owner': ['olga'],
      },
    },
  });
});
