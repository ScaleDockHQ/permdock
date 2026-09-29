import { describe, expect, it } from 'vitest';

import type { Capability } from './capability.ts';
import type { TokenSigner } from './interfaces.ts';
import type { Subject } from './subject.ts';

import {
  capabilityOf,
  capabilitySubject,
  parseCapability,
  redeemerAllows,
  signCapability,
} from './capability.ts';
import { fromSnapshot } from './from-snapshot.ts';
import { createPermDock } from './permdock.ts';
import { definePermissions, resource } from './permissions.ts';
import { allow, definePolicy, role } from './policy.ts';
import { parseSnapshot } from './snapshot.ts';

const permissions = definePermissions({
  quote: resource({
    actions: ['read', 'accept', 'update'],
    relations: {
      organization: { field: 'organizationId', memberOf: 'organization' },
    },
  }),
  folder: resource({ actions: ['read'] }),
  file: resource({
    parent: { field: 'folderId', resource: 'folder' },
    actions: ['read', 'comment', 'update'],
  }),
});

const policy = definePolicy(
  { permissions },
  {
    subject: (user: Subject) => user,
    scopes: { organization: { key: 'organizationId' } },
    roles: [
      role(
        'guest',
        [
          allow(permissions.quote.read, { where: { status: 'sent' } }),
          allow(permissions.quote.accept, { where: { status: 'sent' } }),
        ],
        { on: permissions.quote },
      ),
      role(
        'commenter',
        [allow(permissions.file.read), allow(permissions.file.comment)],
        { on: permissions.folder },
      ),
      role(
        'admin',
        [allow(permissions.quote.update), allow(permissions.quote.read)],
        { on: 'organization' },
      ),
    ],
  },
);

const HOUR = 3600;
const future = (): number => Math.floor(Date.now() / 1000) + HOUR;

function dockFor(capability: Capability) {
  const dock = createPermDock(policy, capabilitySubject(capability));
  if (dock instanceof Promise) {
    throw new TypeError('expected a synchronous instance');
  }
  return dock;
}

const quoteQ = { id: 'q_1', organizationId: 'o_1', status: 'sent' };
const quoteOther = { id: 'q_2', organizationId: 'o_1', status: 'sent' };
const draftQ = { id: 'q_1', organizationId: 'o_1', status: 'draft' };

describe('capabilities', () => {
  it('lets a quote link read and accept quote Q only', () => {
    const dock = dockFor(
      capabilityOf({
        id: 'lnk_1',
        on: { resource: permissions.quote, id: 'q_1' },
        roles: ['guest'],
        expiresAt: future(),
      }),
    );
    expect(dock.can(permissions.quote.read, quoteQ)).toBe(true);
    expect(dock.can(permissions.quote.accept, quoteQ)).toBe(true);
    expect(dock.can(permissions.quote.read, quoteOther)).toBe(false);
    expect(dock.can(permissions.quote.read, draftQ)).toBe(false);
    expect(dock.can(permissions.quote.update, quoteQ)).toBe(false);
    expect(dock.can(permissions.quote.read)).toBe(false);
  });

  it('narrows the role to the listed permissions', () => {
    const dock = dockFor(
      capabilityOf({
        id: 'lnk_2',
        on: { resource: permissions.quote, id: 'q_1' },
        roles: ['guest'],
        permissions: [permissions.quote.read],
        expiresAt: future(),
      }),
    );
    expect(dock.can(permissions.quote.read, quoteQ)).toBe(true);
    const accept = dock.decide(permissions.quote.accept, quoteQ);
    expect(accept.outcome).toBe('denied');
    expect(
      accept.outcome === 'denied' &&
        accept.denials.some((denial) => denial.reason === 'not-delegated'),
    ).toBe(true);
  });

  it('reaches a child file through a folder link, never a sibling', () => {
    const dock = dockFor(
      capabilityOf({
        id: 'lnk_3',
        on: { resource: permissions.folder, id: 'f_1' },
        roles: ['commenter'],
        expiresAt: future(),
      }),
    );
    expect(
      dock.can(permissions.file.comment, { id: 'x_1', folderId: 'f_1' }),
    ).toBe(true);
    expect(
      dock.can(permissions.file.read, { id: 'x_2', folderId: 'f_2' }),
    ).toBe(false);
    expect(
      dock.can(permissions.file.update, { id: 'x_1', folderId: 'f_1' }),
    ).toBe(false);
    expect(dock.where(permissions.file.read).condition).toEqual({
      op: 'eq',
      field: 'folderId',
      value: 'f_1',
    });
  });

  it('never exercises a scope role, even one named in the capability', () => {
    const dock = dockFor(
      capabilityOf({
        id: 'lnk_4',
        on: { resource: permissions.quote, id: 'q_1' },
        roles: ['admin'],
        expiresAt: future(),
      }),
    );
    expect(dock.can(permissions.quote.update, quoteQ)).toBe(false);
    expect(dock.can(permissions.quote.read, quoteQ)).toBe(false);
  });

  it('denies once the capability expires', () => {
    const dock = dockFor(
      capabilityOf({
        id: 'lnk_5',
        on: { resource: permissions.quote, id: 'q_1' },
        roles: ['guest'],
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      }),
    );
    expect(dock.can(permissions.quote.read, quoteQ)).toBe(false);
  });

  it('agrees with a client built from its snapshot', () => {
    const dock = dockFor(
      capabilityOf({
        id: 'lnk_6',
        on: { resource: permissions.quote, id: 'q_1' },
        roles: ['guest'],
        permissions: [permissions.quote.read],
        expiresAt: future(),
      }),
    );
    const client = fromSnapshot(parseSnapshot(JSON.stringify(dock.snapshot())));
    for (const [permission, row] of [
      [permissions.quote.read, quoteQ],
      [permissions.quote.accept, quoteQ],
      [permissions.quote.read, quoteOther],
      [permissions.quote.read, draftQ],
    ] as const) {
      expect(client.can(permission, row)).toBe(dock.can(permission, row));
    }
  });

  it('resolves a reserved key holder to the anonymous subject', () => {
    const capability = parseCapability({
      v: 1,
      id: 'key_1',
      holder: 'key',
      on: { resource: 'quote', id: 'q_1' },
      roles: ['guest'],
      expiresAt: future(),
    });
    expect(capability).toBeDefined();
    expect(capabilitySubject(capability!).principal).toBeNull();
  });
});

describe('parseCapability', () => {
  const valid = {
    v: 1,
    id: 'lnk_1',
    holder: 'link',
    on: { resource: 'quote', id: 'q_1' },
    roles: ['guest'],
    expiresAt: 2_000_000_000,
  };

  it('keeps only v1 fields and freezes the result', () => {
    const parsed = parseCapability({ ...valid, extra: true, once: true });
    expect(parsed).toEqual({ ...valid, once: true });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.on)).toBe(true);
  });

  it.each([
    ['another version', { ...valid, v: 2 }],
    ['an unknown holder', { ...valid, holder: 'user' }],
    ['no roles', { ...valid, roles: [] }],
    ['a non-string role', { ...valid, roles: [1] }],
    ['empty permissions', { ...valid, permissions: [] }],
    ['a bad redeemer', { ...valid, redeemer: { user: 'u_1', scope: 'x' } }],
    ['once: false', { ...valid, once: false }],
    ['a missing expiry', { ...valid, expiresAt: undefined }],
    ['a missing resource id', { ...valid, on: { resource: 'quote' } }],
    ['an array', [valid]],
  ])('rejects %s', (_label, value) => {
    expect(parseCapability(value)).toBeUndefined();
  });

  it('never reads inherited properties', () => {
    const inherited = Object.create({ ...valid }) as object;
    expect(parseCapability(inherited)).toBeUndefined();
  });
});

describe('redeemerAllows', () => {
  const member: Subject = {
    principal: {
      id: 'u_1',
      memberships: [{ scope: 'organization', id: 'o_1', roles: ['member'] }],
    },
    context: {},
  };

  it('checks the viewer, never the capability', () => {
    expect(redeemerAllows(undefined, undefined)).toBe(true);
    expect(redeemerAllows('anyone', undefined)).toBe(true);
    expect(redeemerAllows('signed-in', undefined)).toBe(false);
    expect(redeemerAllows('signed-in', member)).toBe(true);
    expect(redeemerAllows({ user: 'u_1' }, member)).toBe(true);
    expect(redeemerAllows({ user: 'u_2' }, member)).toBe(false);
    expect(redeemerAllows({ scope: 'organization', id: 'o_1' }, member)).toBe(
      true,
    );
    expect(redeemerAllows({ scope: 'organization', id: 'o_2' }, member)).toBe(
      false,
    );
  });

  it('never lets one link redeem another', () => {
    const link = capabilitySubject(
      capabilityOf({
        id: 'lnk_1',
        on: { resource: permissions.quote, id: 'q_1' },
        roles: ['guest'],
        expiresAt: future(),
      }),
    );
    expect(redeemerAllows('signed-in', link)).toBe(false);
  });

  it('ignores an expired scope membership', () => {
    const stale: Subject = {
      principal: {
        id: 'u_1',
        memberships: [
          { scope: 'organization', id: 'o_1', roles: ['member'], expiresAt: 1 },
        ],
      },
      context: {},
    };
    expect(redeemerAllows({ scope: 'organization', id: 'o_1' }, stale)).toBe(
      false,
    );
  });
});

describe('signCapability', () => {
  it('signs the capability under typ permdock-capability+jwt', async () => {
    const calls: unknown[] = [];
    const signer: TokenSigner = {
      sign(payload, options) {
        calls.push({ payload, options });
        return Promise.resolve('jws');
      },
    };
    const expiresAt = future();
    await signCapability(
      {
        id: 'lnk_1',
        on: { resource: permissions.quote, id: 'q_1' },
        roles: ['guest'],
        permissions: [permissions.quote.read],
        once: true,
        expiresAt,
      },
      signer,
      { audience: 'https://app.example.com' },
    );
    expect(calls).toEqual([
      {
        payload: {
          sub: 'lnk_1',
          capability: {
            v: 1,
            id: 'lnk_1',
            holder: 'link',
            on: { resource: 'quote', id: 'q_1' },
            roles: ['guest'],
            permissions: ['quote.read'],
            once: true,
            expiresAt,
          },
        },
        options: {
          typ: 'permdock-capability+jwt',
          audience: 'https://app.example.com',
          expiresAt,
        },
      },
    ]);
  });

  it('refuses a capability spanning two resources', () => {
    expect(() =>
      capabilityOf({
        id: 'lnk_1',
        on: { resource: permissions, id: 'q_1' },
        roles: ['guest'],
        expiresAt: future(),
      }),
    ).toThrow(/exactly one resource/u);
  });

  it('refuses an input no resolver would accept', () => {
    expect(() =>
      capabilityOf({
        id: '',
        on: { resource: permissions.quote, id: 'q_1' },
        roles: ['guest'],
        expiresAt: future(),
      }),
    ).toThrow(/invalid capability/u);
  });
});
