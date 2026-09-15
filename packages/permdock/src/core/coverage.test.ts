import { describe, expect, it } from 'vitest';

import {
  isCondition,
  isConditionDate,
  isConditionRef,
} from '../conditions/ast.ts';
import { evaluateCondition } from '../conditions/evaluate.ts';
import { normalizeWhere } from '../conditions/normalize.ts';
import { opaque } from '../conditions/opaque.ts';
import { context, principal } from '../conditions/refs.ts';
import { compact } from './compact.ts';
import { PermDockDeniedError, PermDockValidationError } from './errors.ts';
import { freezeDeep } from './freeze.ts';
import { memoryRoleSource } from './interfaces.ts';
import { readPath } from './paths.ts';
import { createPermDock } from './permdock.ts';
import {
  definePermissions,
  findPermission,
  getResource,
  listPermissions,
  mergePermissions,
  resource,
} from './permissions.ts';
import { allow, definePolicy, deny, role } from './policy.ts';
import { sha256, bytesToBase64Url } from './sha256.ts';
import { memorySink } from './sink.ts';
import { parseSnapshot } from './snapshot.ts';
import { isPrincipal, isSubject } from './subject.ts';
import {
  parentFieldChain,
  matchScopedMembership,
  nowSeconds,
} from './tenancy.ts';

const tree = definePermissions({
  org: resource({ actions: ['read'] }),
  post: resource({
    id: 'id',
    actions: { read: { label: 'Read' }, update: {}, delete: {} },
    collection: ['create'],
    parent: { field: 'orgId', resource: 'org' },
  }),
});

const policy = definePolicy(tree, {
  roles: [
    role('member', [
      allow(tree.post.read),
      allow(tree.post.create),
      allow(tree.post.update, {
        where: { authorId: principal.id },
        check: { authorId: principal.id },
      }),
      allow([tree.post.delete], { where: { authorId: principal.id } }),
    ]),
    role('viewer', [allow(tree.post.read)], { on: 'tenant' }),
    role('lead', [allow(tree.post.read)], { on: 'team' }),
    role('owner', [allow(tree.post.read)], { on: tree.org.read }),
  ],
  scopes: { tenant: { key: 'orgId' }, team: { key: 'teamId' } },
  subject: (user: { readonly id: string } | null) =>
    user === null ? null : { id: user.id, roles: ['member'] },
  context: (user) => (user === null ? {} : { teamIds: ['t1'] }),
  validate: 'boundary',
  onDenied: () => undefined,
});

describe('coverage edges', () => {
  it('covers permission merge, find, empty merge and object actions', () => {
    const billing = definePermissions({
      billing: {
        invoice: resource({ actions: ['pay'] }),
      },
    });
    const extra = definePermissions({
      billing: {
        credit: resource({ actions: ['refund'] }),
      },
    });
    const merged = mergePermissions(billing, extra);
    expect(findPermission(merged, 'billing.invoice.pay')?.action).toBe('pay');
    expect(findPermission(merged, 'constructor')).toBeUndefined();
    expect(() => mergePermissions()).toThrow(/at least one tree/);
    expect(() => resource()).toThrow(/requires a schema or options/);
    expect(tree.post.read.meta).toEqual({ label: 'Read' });
  });

  it('covers evaluation, listeners, team, snapshot tenants and where', async () => {
    const sink = memorySink({ capacity: 8 });
    const throwingSink = {
      write(): void {
        throw new Error('sink');
      },
    };
    const permdock = await createPermDock(
      policy,
      { id: 'u1' },
      {
        sink,
        actor: { id: 'c1', kind: 'oauth-client' },
        session: 's1',
        expiresAt: 9_999_999_999,
      },
    );
    expect(
      permdock.assert(tree.post.read, { id: 'p1', authorId: 'u1', orgId: 'o1' })
        .outcome,
    ).toBe('granted');
    expect(
      permdock.can(tree.post.update, {
        current: { id: 'p1', authorId: 'u1', orgId: 'o1' },
        next: { id: 'p1', authorId: 'u1', orgId: 'o1' },
      }),
    ).toBe(true);
    expect(
      permdock.can(tree.post.update, {
        id: 'p1',
        authorId: 'nope',
        orgId: 'o1',
      }),
    ).toBe(false);
    expect(permdock.filter(tree.post.read, []).length).toBe(0);
    expect(permdock.where(tree.org.read).partial).toBe(false);
    const decisions: unknown[] = [];
    const approvals: unknown[] = [];
    const errors: unknown[] = [];
    const off = permdock.on('decision', (event) => {
      decisions.push(event);
    });
    permdock.on('approval', (event) => {
      approvals.push(event);
    });
    permdock.on('error', (error) => {
      errors.push(error);
    });
    permdock.on('denied', () => {
      throw new Error('denied-handler');
    });
    expect(permdock.can(tree.org.read, { id: 'o1' })).toBe(false);
    off();
    const signed = await permdock.snapshot({
      tenants: 'all',
      include: [tree.post],
      audience: 'ads',
      signer: {
        sign: async () => 'jws',
      },
    });
    expect(signed).toBe('jws');
    const json = permdock.snapshot();
    if (json instanceof Promise) {
      throw new Error('expected json');
    }
    expect(json.expiresAt).toBe(9_999_999_999);
    expect(permdock.memberships()).toEqual([]);
    expect(permdock.heldRoles().map((item) => item.key)).toEqual(['member']);
    expect(permdock.assignableRoles()).toEqual([]);
    expect(
      permdock
        .team('t1')
        .can(tree.post.read, { id: 'p1', authorId: 'u1', orgId: 'o1' }),
    ).toBe(true);
    const thenableSink = {
      write(): Promise<void> {
        return Promise.reject(new Error('async-sink'));
      },
    };
    const leakingAsync = await createPermDock(
      policy,
      { id: 'u1' },
      { sink: thenableSink },
    );
    leakingAsync.can(tree.post.read, { id: 'p1', authorId: 'u1', orgId: 'o1' });
    const leaking = await createPermDock(
      policy,
      { id: 'u1' },
      { sink: throwingSink },
    );
    leaking.on('error', (error) => {
      errors.push(error);
    });
    leaking.can(tree.post.read, { id: 'p1', authorId: 'u1', orgId: 'o1' });
    expect(errors.length).toBeGreaterThan(0);
    const preview = permdock.simulate({
      memberships: [{ tenant: 'o1', roles: ['viewer'] }],
      tenant: 'o1',
    });
    if (Array.isArray(preview)) {
      throw new Error('expected instance');
    }
    expect(preview.tenants()).toEqual(['o1']);
  });

  it('covers scoped memberships, parents, delegation and sources', async () => {
    const scoped = definePolicy(tree, {
      roles: [
        role('viewer', [allow(tree.post.read)], { on: 'tenant' }),
        role('lead', [allow(tree.post.read)], { on: 'team' }),
        role('owner', [allow(tree.post.read)], { on: tree.post }),
      ],
      scopes: { tenant: { key: 'orgId' }, team: { key: 'teamId' } },
      subject: () => ({
        id: 'u1',
        memberships: [
          { tenant: 'o1', roles: ['viewer'] },
          { tenant: 'o1', team: 't1', roles: ['lead'] },
          { on: { resource: 'org', id: 'o1' }, roles: ['owner'] },
          {
            tenant: 'o1',
            team: 't1',
            on: { resource: 'post', id: 'p1' },
            roles: ['invalid'],
          },
        ],
      }),
    });
    const permdock = await createPermDock(
      scoped,
      { id: 'u1' },
      { tenant: 'o1' },
    );
    expect(
      permdock.can(tree.post.read, { id: 'p1', orgId: 'o1', teamId: 't1' }),
    ).toBe(true);
    expect(permdock.heldRoles({ tenant: 'missing' })).toEqual([]);
    expect(
      permdock
        .team('t9')
        .can(tree.post.read, { id: 'p1', orgId: 'o1', teamId: 't1' }),
    ).toBe(false);
    const delegated = await createPermDock(policy, {
      principal: { id: 'u1', roles: ['member'] },
      context: {},
      delegation: {
        scopes: [],
        authorizationDetails: [{ type: 'post', actions: ['read'] }],
      },
    });
    expect(
      delegated.can(tree.post.read, { id: 'p1', authorId: 'u1', orgId: 'o1' }),
    ).toBe(true);
    expect(delegated.can(tree.post.create)).toBe(false);
    const emptyScopes = await createPermDock(policy, {
      principal: { id: 'u1', roles: ['member'] },
      context: {},
      delegation: { scopes: [] },
    });
    const denied = emptyScopes.decide(tree.post.read, {
      id: 'p1',
      authorId: 'u1',
      orgId: 'o1',
    });
    if (denied.outcome === 'denied') {
      expect(denied.denials[0]?.reason).toBe('no-delegation');
    }
    const resources = tree as unknown as { readonly [key: string]: unknown };
    void resources;
    expect(parentFieldChain(undefined, new Map()).length).toBe(0);
    const org = (await import('./permissions.ts')).getResource(tree, 'org');
    const post = (await import('./permissions.ts')).getResource(tree, 'post');
    expect(
      parentFieldChain(
        post,
        new Map([
          ['org', org!],
          ['post', post!],
        ]),
      ),
    ).toEqual(['orgId']);
    const cycled = post!;
    const looping = new Map([
      [
        'post',
        {
          ...cycled,
          parent: { field: 'orgId', resource: 'post' },
        },
      ],
    ]);
    expect(
      parentFieldChain(looping.get('post'), looping).length,
    ).toBeGreaterThan(0);

    const throwingSource = await createPermDock(
      policy,
      { id: 'u1', roles: ['member'] },
      {
        memberships: {
          membershipsFor(): never {
            throw new Error('boom');
          },
        },
      },
    );
    const auth: unknown[] = [];
    throwingSource.on('auth', (event) => {
      auth.push(event);
    });
    expect(auth[0]).toMatchObject({ reason: 'source-threw' });

    const asyncDock = await createPermDock(
      definePolicy(tree, {
        roles: [role('member', [allow(tree.post.read)])],
        subject: () => ({ id: 'u1', roles: ['member'] }),
        context: async () => ({ async: true }),
      }),
      { id: 'u1' },
      {
        memberships: {
          membershipsFor: async () => {
            throw new Error('async-fail');
          },
        },
        customRoles: {
          rolesFor: async () => {
            throw new Error('roles');
          },
        },
      },
    );
    expect(
      asyncDock.can(tree.post.read, { id: 'p1', authorId: 'u1', orgId: 'o1' }),
    ).toBe(true);

    const throwingRoles = await createPermDock(
      policy,
      {
        principal: {
          id: 'u1',
          roles: ['member'],
          memberships: [{ tenant: 'o1', roles: ['member'] }],
        },
        context: {},
      },
      {
        customRoles: {
          rolesFor(): never {
            throw new Error('roles');
          },
        },
      },
    );
    const roleAuth: unknown[] = [];
    throwingRoles.on('auth', (event) => {
      roleAuth.push(event);
    });
    expect(roleAuth.length).toBeGreaterThan(0);

    const anonymous = await createPermDock(policy, null);
    expect(anonymous.tenant('o1').can(tree.post.read, { id: 'p1' })).toBe(
      false,
    );
    expect(anonymous.heldRoles()).toEqual([]);
    expect(anonymous.memberships()).toEqual([]);
    expect(
      anonymous
        .simulate({ roles: ['member'] })
        .can(tree.post.read, { id: 'p1', authorId: 'u1' }),
    ).toBe(false);
  });

  it('covers validation, closures, onDenied and can catch', async () => {
    const schemaPolicy = definePolicy(tree, {
      roles: [
        role('member', [
          allow(tree.post.read, () => {
            throw new Error('closure');
          }),
          allow(tree.post.create, { check: { authorId: 'u1' } }),
          allow(tree.post.update, {
            where: opaque({ sql: '1=1', fingerprint: 'x' }),
          }),
        ]),
      ],
      subject: () => ({ id: 'u1', roles: ['member'] }),
      validate: 'never',
    });
    const permdock = await createPermDock(schemaPolicy, { id: 'u1' });
    const closed = permdock.decide(tree.post.read, { id: 'p1' });
    expect(closed.outcome).toBe('denied');
    expect(permdock.where(tree.post.read).partial).toBe(true);
    expect(permdock.can(tree.post.create)).toBe(false);
    const opaqueDecision = permdock.decide(tree.post.update, {
      id: 'p1',
      authorId: 'u1',
    });
    expect(opaqueDecision.outcome).toBe('denied');

    const withSchema = definePermissions({
      post: resource(
        {
          '~standard': {
            version: 1 as const,
            vendor: 'test',
            validate: (value: unknown) =>
              typeof value === 'object' &&
              value !== null &&
              typeof (value as { id?: unknown }).id === 'string'
                ? { value }
                : { issues: [{ message: 'required', path: [{ key: 'id' }] }] },
          },
        },
        { actions: ['read'] },
      ),
    });
    const schemaed = definePolicy(withSchema, {
      roles: [role('member', [allow(withSchema.post.read)])],
      subject: () => ({ id: 'u1', roles: ['member'] }),
      validate: 'always',
    });
    const dock = await createPermDock(schemaed, { id: 'u1' });
    expect(
      dock.decide(withSchema.post.read, { id: 1 }, { trusted: false }).outcome,
    ).toBe('denied');
    expect(() =>
      dock.assert(withSchema.post.read, { id: 1 }, { trusted: false }),
    ).toThrow(PermDockValidationError);
    expect(dock.can(withSchema.post.read, { id: 1 }, { trusted: false })).toBe(
      false,
    );
    expect(dock.can(withSchema.post.read, { id: 'p1' })).toBe(true);
    expect(() =>
      dock.assert(
        withSchema.post.read,
        { id: 'p1' },
        { trusted: false, onDenied: () => undefined },
      ),
    ).not.toThrow();
    const noGrant = definePolicy(withSchema, {
      roles: [role('member', [allow(withSchema.post.read)])],
      subject: () => ({ id: 'u1', roles: [] }),
    });
    const empty = await createPermDock(noGrant, { id: 'u1', roles: [] });
    expect(() => empty.assert(withSchema.post.read, { id: 'p1' })).toThrow(
      PermDockDeniedError,
    );

    const asyncSchema = definePermissions({
      post: resource(
        {
          '~standard': {
            version: 1 as const,
            vendor: 'test',
            validate: () => Promise.resolve({ value: { id: 'p1' } }),
          },
        },
        { actions: ['read'] },
      ),
    });
    const asyncPolicy = definePolicy(asyncSchema, {
      roles: [role('member', [allow(asyncSchema.post.read)])],
      subject: () => ({ id: 'u1', roles: ['member'] }),
      validate: 'always',
    });
    const asyncDock = await createPermDock(asyncPolicy, { id: 'u1' });
    expect(
      asyncDock.can(asyncSchema.post.read, { id: 'p1' }, { trusted: false }),
    ).toBe(false);
  });

  it('covers conditions, tenancy helpers, compact, freeze and snapshot parse', () => {
    const now = nowSeconds(1_700_000_000);
    const data = {
      n: 2,
      s: 'ab',
      list: ['x'],
      when: new Date('2020-01-02T00:00:00.000Z'),
      stamp: 1,
      bad: { nope: true },
    };
    const lead = {
      id: 'u1',
      tenant: 'o1',
      memberships: [
        { tenant: 'o1', team: 't1', roles: ['lead'] },
        { on: { resource: 'folder', id: 'f1' }, roles: ['editor'] },
      ],
    };
    const sub = { principal: lead, context: { teamIds: ['t1'] } };
    expect(
      evaluateCondition(normalizeWhere({ n: { ne: 1 } }), data, sub, now),
    ).toBe(true);
    expect(
      evaluateCondition(normalizeWhere({ n: { gte: 2 } }), data, sub, now),
    ).toBe(true);
    expect(
      evaluateCondition(normalizeWhere({ n: { lt: 3 } }), data, sub, now),
    ).toBe(true);
    expect(
      evaluateCondition(normalizeWhere({ n: { lte: 2 } }), data, sub, now),
    ).toBe(true);
    expect(
      evaluateCondition(
        normalizeWhere({ s: { isNull: false } }),
        data,
        sub,
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(normalizeWhere({ n: { contains: 1 } }), data, sub, now),
    ).toBe(false);
    expect(
      evaluateCondition(
        { op: 'memberOf', scope: 'team', field: 'teamId', roles: ['solo'] },
        { teamId: 't9' },
        {
          principal: {
            id: 'u1',
            memberships: [{ team: 't9', roles: ['solo'] }],
          },
          context: {},
        },
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: ['viewer'] },
        {},
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        normalizeWhere({ s: { contains: null } }),
        data,
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        normalizeWhere({ n: { in: context.teamIds } }),
        data,
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition({ op: 'eq', field: 'n', value: 2 }, null, sub, now),
    ).toBe(false);
    expect(
      evaluateCondition(
        { op: 'contains', field: 's', value: 'a' },
        null,
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition({ op: 'in', field: 'n', value: [2] }, null, sub, now),
    ).toBe(false);
    expect(
      evaluateCondition(
        { op: 'isNull', field: 's', value: true },
        null,
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { op: 'eq', field: 'when', value: { date: 'not-a-date' } },
        { when: 'also-bad' },
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { op: 'gt', field: 'stamp', value: 0 },
        { stamp: Number.NaN },
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        {
          op: 'eq',
          field: 'when',
          value: new Date('2020-01-02T00:00:00.000Z') as never,
        },
        { when: new Date('2020-01-02T00:00:00.000Z') },
        sub,
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        {
          op: 'memberOf',
          scope: 'resource',
          field: 'id',
          roles: ['editor'],
          resource: 'document',
          parents: ['folderId'],
        },
        { id: 'd1', folderId: 'f1' },
        sub,
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { op: 'memberOf', scope: 'team', field: 'teamId', roles: ['lead'] },
        { teamId: 't1' },
        { principal: { ...lead, tenant: 'other' }, context: {} },
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: ['lead'] },
        'nope',
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { op: 'eq', field: 'n', value: { ref: 'other.id' } },
        data,
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { op: 'eq', field: 'n', value: { ref: 'subject' } },
        data,
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { op: 'eq', field: 'id', value: { ref: 'principal.id' } },
        { id: 'u1' },
        sub,
        now,
      ),
    ).toBe(true);

    expect(isCondition({ op: 'eq', field: 'a', value: 1 })).toBe(true);
    expect(isConditionDate({ date: '2020-01-01T00:00:00.000Z' })).toBe(true);
    expect(isConditionRef({ ref: 'principal.id' })).toBe(true);
    expect(normalizeWhere({ sql: '1=1', fingerprint: 'z' }).op).toBe('opaque');
    expect(() => normalizeWhere({ and: { a: 1 } })).toThrow(/and requires/);
    expect(() => normalizeWhere({ or: { a: 1 } })).toThrow(/or requires/);
    expect(() => normalizeWhere({ a: { isNull: 'yes' } })).toThrow(/boolean/);
    expect(() => normalizeWhere({ a: { in: 'x' } })).toThrow(/array/);
    expect(() => normalizeWhere(1)).toThrow(/must be an object/);
    expect(() => normalizeWhere({ a: { nope: true } })).toThrow(/unsupported/);
    expect(normalizeWhere({ a: { in: principal.id } }).op).toBe('in');
    const nested = normalizeWhere({
      or: [{ a: 1 }, { or: [{ b: 2 }] }],
    });
    expect(nested.op).toBe('or');
    expect(JSON.stringify(principal.id)).toContain('principal.id');
    expect(Object.keys(principal.id)).toEqual(['ref']);
    expect(
      principal.id[Symbol.toStringTag as unknown as string],
    ).toBeUndefined();

    const tenantSubject = {
      principal: {
        id: 'u1',
        tenant: 'o1',
        memberships: [{ tenant: 'o1', roles: ['viewer'] }],
      },
      context: {},
    };
    expect(
      matchScopedMembership(
        tenantSubject,
        'tenant',
        'viewer',
        { orgId: 'o2' },
        { tenant: { key: 'orgId' } },
        undefined,
        now,
      ).ok,
    ).toBe(false);
    expect(
      matchScopedMembership(
        { principal: null, context: {} },
        'tenant',
        'viewer',
        {},
        {},
        undefined,
        now,
      ).ok,
    ).toBe(false);
    expect(
      matchScopedMembership(
        {
          principal: {
            id: 'u1',
            tenant: 'o1',
            memberships: [{ tenant: 'o1', team: 't1', roles: ['lead'] }],
          },
          context: {},
        },
        'team',
        'lead',
        { teamId: 'other' },
        { team: { key: 'teamId' } },
        undefined,
        now,
      ).ok,
    ).toBe(false);
    expect(
      matchScopedMembership(
        tenantSubject,
        { resource: 'post' },
        'viewer',
        { id: 'p1' },
        {},
        undefined,
        now,
      ).ok,
    ).toBe(false);
    const expiredOnly = matchScopedMembership(
      {
        principal: {
          id: 'u1',
          tenant: 'gone',
          memberships: [{ tenant: 'gone', roles: ['viewer'], expiresAt: 1 }],
        },
        context: {},
      },
      'tenant',
      'viewer',
      {},
      {},
      undefined,
      now,
    );
    expect(expiredOnly.ok).toBe(false);

    expect(isPrincipal([])).toBe(false);
    expect(isPrincipal({ id: 1 })).toBe(false);
    expect(isSubject({ principal: null, context: 'nope' })).toBe(false);
    expect(isSubject(null)).toBe(false);
    freezeDeep(() => undefined);
    expect(readPath({ a: null }, 'a.b')).toBeUndefined();
    expect(compact<{ readonly a: number }>({ a: 1, b: undefined })).toEqual({
      a: 1,
    });
    expect(() => parseSnapshot([])).toThrow(/must be an object/);
    expect(() =>
      parseSnapshot({ v: 2, nested: { __proto__: {} } }),
    ).not.toThrow();
    const hashed = bytesToBase64Url(sha256('hello'));
    expect(hashed.length).toBeGreaterThan(10);
    expect(
      role('limited', [
        allow(tree.post.read, { limit: { count: 1, per: 'hour' } }),
      ]).grants[0]?.portable,
    ).toBe(false);
    expect(deny([tree.post.read, tree.post.create])).toHaveLength(2);
    expect(() =>
      definePolicy(tree, {
        roles: [role('lead', [allow(tree.post.read)], { on: 'team' })],
        subject: () => ({ id: 'u1' }),
      }),
    ).toThrow(/scopes.team/);
    expect(() =>
      role('broken', [allow(tree.post.read)], {
        on: [tree.post.read, tree.org.read],
      }),
    ).toThrow(/exactly one resource/);
    const neverPolicy = definePolicy(tree, {
      roles: [role('member', [allow(tree.post.read)])],
      subject: () => ({ id: 'u1', roles: ['member'] }),
      validate: 'never',
    });
    expect(neverPolicy.validate).toBe('never');
    const source = memoryRoleSource([]);
    expect(source.rolesFor('missing')).toEqual([]);
    expect(
      evaluateCondition(
        {
          op: 'memberOf',
          scope: 'resource',
          field: 'id',
          roles: ['editor'],
          resource: 'folder',
          parents: ['folderId'],
        },
        { id: 'f1', folderId: 'f1' },
        sub,
        now,
      ),
    ).toBe(true);
    evaluateCondition({ op: 'zzz' } as never, data, sub, now);
    expect(normalizeWhere({ tags: ['draft', 'live'] }).op).toBe('eq');
    expect(
      normalizeWhere({
        and: [{ and: [{ n: 2 }, { s: 'ab' }] }, { n: { gte: 1 } }],
      }).op,
    ).toBe('and');
    expect(
      Object.getOwnPropertyDescriptor(principal.id, 'missing'),
    ).toBeUndefined();
    expect(
      evaluateCondition(
        {
          op: 'memberOf',
          scope: 'resource',
          field: 'id',
          roles: ['editor'],
          resource: 'folder',
          parents: ['folderId'],
        },
        { id: 'other', folderId: 'f1' },
        sub,
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        {
          op: 'memberOf',
          scope: 'resource',
          field: 'id',
          roles: ['lead'],
          resource: 'document',
        },
        { id: 'd1' },
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        {
          op: 'memberOf',
          scope: 'resource',
          field: 'id',
          roles: ['editor'],
          resource: 'document',
          parents: ['missing'],
        },
        { id: 'd1', missing: 'nope' },
        sub,
        now,
      ),
    ).toBe(false);
    expect(() => normalizeWhere({ op: 'and', conditions: [] })).toThrow(
      /empty and/,
    );
    expect(
      normalizeWhere({ authorId: opaque({ sql: '1', fingerprint: 'f' }) }).op,
    ).toBe('opaque');
    expect(
      normalizeWhere({ tags: { in: [new Date('2020-01-01T00:00:00Z'), 'x'] } })
        .op,
    ).toBe('in');
    expect(
      role('nested', [deny([tree.post.read, tree.post.create])]).grants,
    ).toHaveLength(2);
    expect(() => role('empty-on', [allow(tree.post.read)], { on: [] })).toThrow(
      /exactly one resource/,
    );
    expect(principal.id[Symbol.iterator as unknown as string]).toBeUndefined();
    expect(parseSnapshot({ v: 1, grants: [] }).v).toBe(1);
    expect(
      matchScopedMembership(
        {
          principal: {
            id: 'u1',
            memberships: [
              { on: { resource: 'post', id: 'p1' }, roles: ['owner'] },
            ],
          },
          context: {},
        },
        { resource: 'post' },
        'owner',
        { id: 'p1' },
        {},
        undefined,
        now,
      ).ok,
    ).toBe(true);
    expect(
      matchScopedMembership(
        {
          principal: {
            id: 'u1',
            memberships: [
              { on: { resource: 'post', id: 'p1' }, roles: ['owner'] },
            ],
          },
          context: {},
        },
        { resource: 'post' },
        'owner',
        null,
        {},
        undefined,
        now,
      ).ok,
    ).toBe(false);
    expect(
      matchScopedMembership(
        {
          principal: {
            id: 'u1',
            memberships: [
              { on: { resource: 'org', id: 'o1' }, roles: ['owner'] },
            ],
          },
          context: {},
        },
        { resource: 'post' },
        'owner',
        { id: 'p1', orgId: 'o9' },
        {},
        {
          name: 'post',
          path: 'post',
          id: 'id',
          schema: undefined,
          parent: { field: 'orgId', resource: 'org' },
          instanceActions: new Set(),
          collectionActions: new Set(),
        },
        now,
      ).ok,
    ).toBe(false);
  });

  it('covers remaining merge, snapshot and async factory paths', async () => {
    expect(() =>
      mergePermissions(
        definePermissions({ post: resource({ actions: ['read'] }) }),
        definePermissions({ post: resource({ actions: ['write'] }) }),
      ),
    ).toThrow(/duplicate resource name/);
    const asyncRoles = await createPermDock(
      policy,
      {
        principal: {
          id: 'u1',
          roles: ['member'],
          memberships: [{ tenant: 'o1', roles: ['member'] }],
        },
        context: {},
      },
      {
        customRoles: {
          async rolesFor() {
            return [];
          },
        },
      },
    );
    expect(
      asyncRoles.can(tree.post.read, { id: 'p1', authorId: 'u1', orgId: 'o1' }),
    ).toBe(true);
    const throwingSubject = await createPermDock(
      definePolicy(tree, {
        roles: [role('member', [allow(tree.post.read)])],
        subject: () => {
          throw new Error('subject');
        },
      }),
      { id: 'u1' },
    );
    expect(throwingSubject.can(tree.post.read, { id: 'p1' })).toBe(false);
    const scopedSnap = await createPermDock(
      definePolicy(tree, {
        roles: [role('viewer', [allow(tree.post.read)], { on: 'tenant' })],
        scopes: { tenant: { key: 'orgId' } },
        subject: () => ({
          id: 'u1',
          memberships: [{ tenant: 'o1', roles: ['viewer'] }],
        }),
      }),
      { id: 'u1' },
      { tenant: 'o1' },
    );
    const snap = scopedSnap.snapshot({
      include: [tree.post.read],
      tenants: 'all',
    });
    if (snap instanceof Promise) {
      throw new Error('json');
    }
    expect(snap.grants.some((grant) => grant.scope === 'tenant')).toBe(true);
    const anonymousSnap = (await createPermDock(policy, null)).snapshot();
    if (anonymousSnap instanceof Promise) {
      throw new Error('json');
    }
    expect(anonymousSnap.subject.principal).toBeNull();
    expect(
      scopedSnap.filter(tree.post.read, [
        { id: 'p1', orgId: 'o9', authorId: 'u1' },
      ]),
    ).toEqual([]);
    const noSchema = await createPermDock(
      definePolicy(tree, {
        roles: [role('member', [allow(tree.post.read)])],
        subject: () => ({ id: 'u1', roles: ['member'] }),
        validate: 'boundary',
      }),
      { id: 'u1' },
    );
    expect(noSchema.can(tree.post.read, { id: 'p1' }, { trusted: false })).toBe(
      true,
    );
    expect(
      (
        await createPermDock(
          definePolicy(tree, {
            roles: [
              role('member', [
                allow(tree.post.delete, {
                  where: { authorId: principal.id },
                  approval: 'human',
                }),
              ]),
            ],
            subject: () => ({ id: 'u1', roles: ['member'] }),
          }),
          { id: 'u1' },
        )
      ).filter(tree.post.delete, [{ id: 'p1', authorId: 'u1', orgId: 'o1' }]),
    ).toEqual([]);
    const teamPolicy = definePolicy(tree, {
      roles: [role('lead', [allow(tree.post.read)], { on: 'team' })],
      scopes: { team: { key: 'teamId' }, tenant: { key: 'orgId' } },
      subject: () => ({
        id: 'u1',
        memberships: [{ tenant: 'o1', team: 't1', roles: ['lead'] }],
      }),
    });
    const teamDock = await createPermDock(
      teamPolicy,
      { id: 'u1' },
      { tenant: 'o1' },
    );
    const teamSnap = teamDock.snapshot();
    if (teamSnap instanceof Promise) {
      throw new Error('json');
    }
    expect(teamSnap.grants.some((grant) => grant.scope === 'team')).toBe(true);
    expect(teamDock.snapshot({ include: [] })).toBeDefined();
    const authErrors: unknown[] = [];
    const throwingAuth = await createPermDock(
      policy,
      { id: 'u1', roles: ['member'] },
      {
        memberships: {
          membershipsFor(): never {
            throw new Error('boom');
          },
        },
      },
    );
    throwingAuth.on('error', (error) => {
      authErrors.push(error);
    });
    throwingAuth.on('auth', () => {
      throw new Error('auth-handler');
    });
    expect(authErrors.length).toBeGreaterThan(0);
    expect(findPermission(tree, 'constructor')).toBeUndefined();
    expect(findPermission(tree, 'post:read')?.action).toBe('read');
    expect(() => resource(tree as never, { actions: ['read'] })).toThrow(
      /must be a schema or options/,
    );
    expect(getResource(tree, 'missing')).toBeUndefined();
    expect(getResource(tree, 'constructor')).toBeUndefined();
    expect(listPermissions(tree.post.read)).toHaveLength(1);
    expect(() =>
      definePermissions({ post: resource({ actions: ['read', 'read'] }) }),
    ).toThrow(/duplicate action/);
    expect(() =>
      definePermissions({
        post: resource({ actions: ['read'], collection: ['read'] }),
      }),
    ).toThrow(/duplicate action/);
    const resourceSnap = await createPermDock(
      definePolicy(tree, {
        roles: [role('owner', [allow(tree.post.read)], { on: tree.post })],
        subject: () => ({
          id: 'u1',
          memberships: [
            { on: { resource: 'post', id: 'p1' }, roles: ['owner'] },
          ],
        }),
      }),
      { id: 'u1' },
    );
    const owned = resourceSnap.snapshot();
    if (owned instanceof Promise) {
      throw new Error('json');
    }
    expect(owned.grants.some((grant) => typeof grant.scope === 'object')).toBe(
      true,
    );
    expect(
      matchScopedMembership(
        {
          principal: {
            id: 'u1',
            memberships: [{ tenant: 'o1', team: 't1', roles: ['lead'] }],
          },
          context: {},
        },
        'team',
        'lead',
        { teamId: 't1' },
        { team: { key: 'teamId' } },
        undefined,
        1_700_000_000,
      ).ok,
    ).toBe(false);
    expect(
      matchScopedMembership(
        {
          principal: {
            id: 'u1',
            tenant: 'o1',
            memberships: [{ tenant: 'o1', roles: ['viewer'] }],
          },
          context: {},
        },
        'team',
        'viewer',
        { teamId: 't1' },
        { team: { key: 'teamId' } },
        undefined,
        1_700_000_000,
      ).ok,
    ).toBe(false);
  });
});
