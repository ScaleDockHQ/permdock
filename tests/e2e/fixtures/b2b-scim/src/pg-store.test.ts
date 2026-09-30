import type { DirectoryStore, ScimFilter } from 'permdock/scim';

import { PGlite } from '@electric-sql/pglite';
import { DirectoryUniquenessError, memoryDirectoryStore } from 'permdock/scim';
import { testDirectoryStore } from 'permdock/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { pgDirectoryStore } from './pg-store.ts';

async function freshStore() {
  const store = pgDirectoryStore(new PGlite());
  await store.ready();
  return store;
}

const conformance = await freshStore();

describe('pgDirectoryStore conformance', () => {
  testDirectoryStore(conformance, { tenants: ['acme', 'globex'] });
});

/** The same writes against both stores, so reads can be compared. */
async function seed(store: DirectoryStore): Promise<void> {
  const users = [
    { id: 'u1', userName: 'ada@acme.test', externalId: 'ada', active: true },
    { id: 'u2', userName: 'bea@acme.test', active: false },
    { id: 'u3', userName: 'cy@other.test', externalId: 'cy', active: true },
  ];
  for (const user of users) {
    await store.putUser('acme', {
      ...user,
      meta: { created: '', lastModified: '' },
    });
  }
  await store.putGroup('acme', {
    id: 'g1',
    displayName: 'Engineering',
    members: [{ value: 'u1' }, { value: 'u3' }],
    roles: ['member'],
    meta: { created: '', lastModified: '' },
  });
  await store.putGroup('acme', {
    id: 'g2',
    displayName: 'Empty',
    members: [],
    meta: { created: '', lastModified: '' },
  });
}

const userFilters: readonly ScimFilter[] = [
  { op: 'eq', attribute: 'userName', value: 'ada@acme.test' },
  { op: 'ne', attribute: 'externalId', value: 'ada' },
  { op: 'co', attribute: 'userName', value: '@acme' },
  { op: 'sw', attribute: 'userName', value: 'b' },
  { op: 'pr', attribute: 'externalId' },
  { op: 'eq', attribute: 'active', value: false },
  { op: 'eq', attribute: 'active', value: 'TRUE' },
  { op: 'co', attribute: 'active', value: 'tr' },
  {
    op: 'or',
    filters: [
      { op: 'eq', attribute: 'id', value: 'u2' },
      {
        op: 'and',
        filters: [
          { op: 'pr', attribute: 'externalId' },
          { op: 'sw', attribute: 'userName', value: 'cy' },
        ],
      },
    ],
  },
];

const groupFilters: readonly ScimFilter[] = [
  { op: 'eq', attribute: 'members.value', value: 'u3' },
  { op: 'ne', attribute: 'members.value', value: 'u1' },
  { op: 'pr', attribute: 'members.value' },
  { op: 'sw', attribute: 'displayName', value: 'Eng' },
  { op: 'pr', attribute: 'externalId' },
];

describe('pgDirectoryStore parity with memoryDirectoryStore', () => {
  const memory = memoryDirectoryStore();
  let pg: DirectoryStore;

  beforeAll(async () => {
    pg = await freshStore();
    await seed(memory);
    await seed(pg);
  });

  it.each(userFilters.map((filter) => [JSON.stringify(filter), filter]))(
    'users %s',
    async (_name, filter) => {
      const ids = async (store: DirectoryStore) =>
        (await store.findUsers('acme', filter, {})).Resources.map(
          (user) => user.id,
        );
      expect(await ids(pg)).toEqual(await ids(memory));
    },
  );

  it.each(groupFilters.map((filter) => [JSON.stringify(filter), filter]))(
    'groups %s',
    async (_name, filter) => {
      const ids = async (store: DirectoryStore) =>
        (await store.findGroups('acme', filter, {})).Resources.map(
          (group) => group.id,
        );
      expect(await ids(pg)).toEqual(await ids(memory));
    },
  );

  it('pages by cursor and by startIndex the same way', async () => {
    for (const page of [
      { count: 2 },
      { count: 2, cursor: '2' },
      { startIndex: 2, count: 1 },
      { count: 5, cursor: '9' },
    ]) {
      const [left, right] = await Promise.all([
        pg.findUsers('acme', undefined, page),
        memory.findUsers('acme', undefined, page),
      ]);
      expect({
        ...left,
        Resources: left.Resources.map((user) => user.id),
      }).toEqual({
        ...right,
        Resources: right.Resources.map((user) => user.id),
      });
    }
  });

  it('keeps userName and externalId unique per tenant only', async () => {
    const duplicate = {
      id: 'u9',
      userName: 'ada@acme.test',
      active: true,
      meta: { created: '', lastModified: '' },
    };
    await expect(pg.putUser('acme', duplicate)).rejects.toBeInstanceOf(
      DirectoryUniquenessError,
    );
    await expect(
      pg.putUser('acme', {
        ...duplicate,
        userName: 'new@acme.test',
        externalId: 'ada',
      }),
    ).rejects.toBeInstanceOf(DirectoryUniquenessError);
    await expect(pg.putUser('globex', duplicate)).resolves.toMatchObject({
      id: 'u9',
    });
  });

  it('applies member patches like the memory store', async () => {
    const ops = [
      { op: 'add' as const, path: 'members', value: [{ value: 'u2' }] },
      { op: 'remove' as const, path: 'members', value: [{ value: 'u1' }] },
      { op: 'replace' as const, path: 'roles', value: ['admin', 7] },
    ];
    const [left, right] = await Promise.all([
      pg.patchGroup('acme', 'g1', ops),
      memory.patchGroup('acme', 'g1', ops),
    ]);
    expect(left.members).toEqual(right.members);
    expect(left.roles).toEqual(right.roles);
    expect(left.meta.created <= left.meta.lastModified).toBe(true);
  });
});
