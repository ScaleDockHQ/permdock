import { describe, expect, it } from 'vitest';

import type { DirectoryGroup, DirectoryUser } from '../../src/scim/types.ts';

import { memoryDirectoryStore } from '../../src/scim/store.ts';
import {
  DirectoryNotFoundError,
  DirectoryUniquenessError,
  isDirectoryNotFoundError,
} from '../../src/scim/types.ts';

const A = 'o_a';
const B = 'o_b';
const META = { created: '', lastModified: '' };

function user(fields: Partial<DirectoryUser> = {}): DirectoryUser {
  return { id: '', userName: 'ada', active: true, meta: META, ...fields };
}

function group(fields: Partial<DirectoryGroup> = {}): DirectoryGroup {
  return { id: '', displayName: 'Eng', members: [], meta: META, ...fields };
}

describe('memoryDirectoryStore users', () => {
  it('assigns ids, stamps meta and keeps created across writes', async () => {
    const store = memoryDirectoryStore();
    const created = await store.putUser(A, user());
    expect(created.id).toMatch(/^u_[0-9a-f]{16}$/u);
    expect(created.meta.resourceType).toBe('User');
    expect(created.meta.created).not.toBe('');
    expect(Object.isFrozen(created)).toBe(true);
    const replaced = await store.putUser(
      A,
      user({ id: created.id, userName: 'ada2' }),
    );
    expect(replaced.meta.created).toBe(created.meta.created);
    const patched = await store.patchUser(A, created.id, [
      { op: 'replace', path: 'userName', value: 'ada3' },
    ]);
    expect(patched.meta.created).toBe(created.meta.created);
  });

  it('never answers across tenants', async () => {
    const store = memoryDirectoryStore();
    const stored = await store.putUser(A, user({ id: 'u_1', externalId: 'x' }));
    await store.putGroup(A, group({ id: 'g_1', members: [{ value: 'u_1' }] }));
    expect(await store.getUser(B, stored.id)).toBeNull();
    expect((await store.findUsers(B, undefined, {})).totalResults).toBe(0);
    expect(await store.groupsFor(B, 'u_1')).toEqual([]);
    expect(await store.getGroup(B, 'g_1')).toBeNull();
    await expect(store.patchUser(B, 'u_1', [])).rejects.toBeInstanceOf(
      DirectoryNotFoundError,
    );
    await expect(store.deleteUser(B, 'u_1')).rejects.toBeInstanceOf(
      DirectoryNotFoundError,
    );
    await expect(store.patchGroup(B, 'g_1', [])).rejects.toBeInstanceOf(
      DirectoryNotFoundError,
    );
    await expect(store.deleteGroup(B, 'g_1')).rejects.toBeInstanceOf(
      DirectoryNotFoundError,
    );
    // The same userName and externalId are free in another tenant.
    await expect(
      store.putUser(B, user({ id: 'u_1', externalId: 'x' })),
    ).resolves.toMatchObject({ id: 'u_1' });
    expect(await store.getUser(A, 'u_1')).toMatchObject({ userName: 'ada' });
  });

  it('enforces userName and externalId uniqueness per tenant', async () => {
    const store = memoryDirectoryStore();
    await store.putUser(A, user({ id: 'u_1', externalId: 'e1' }));
    await expect(store.putUser(A, user({ id: 'u_2' }))).rejects.toMatchObject({
      code: 'uniqueness',
      message: 'userName',
    });
    await expect(
      store.putUser(A, user({ id: 'u_2', userName: 'bob', externalId: 'e1' })),
    ).rejects.toMatchObject({ message: 'externalId' });
    await store.putUser(A, user({ id: 'u_2', userName: 'bob' }));
    await expect(
      store.patchUser(A, 'u_2', [
        { op: 'replace', path: 'userName', value: 'ada' },
      ]),
    ).rejects.toBeInstanceOf(DirectoryUniquenessError);
    expect(await store.getUser(A, 'u_2')).toMatchObject({ userName: 'bob' });
  });

  it('applies user patch operations', async () => {
    const store = memoryDirectoryStore();
    await store.putUser(A, user({ id: 'u_1', externalId: 'e1' }));
    const next = await store.patchUser(A, 'u_1', [
      { op: 'replace', path: 'active', value: false },
      { op: 'replace', path: 'active', value: 'no' },
      { op: 'replace', path: 'userName', value: 42 },
      { op: 'replace', path: 'externalId', value: 'e2' },
      {
        op: 'replace',
        path: 'emails',
        value: [
          { value: 'a@x', primary: true, type: 'work' },
          { value: 'b@x', primary: 'yes', type: 3 },
          { value: 4 },
          null,
          'c@x',
        ],
      },
      { op: 'add', path: 'title', value: 'ignored' },
      { op: 'add', value: 'pathless' },
    ]);
    expect({
      active: next.active,
      userName: next.userName,
      externalId: next.externalId,
      emails: next.emails,
    }).toEqual({
      active: false,
      userName: 'ada',
      externalId: 'e2',
      emails: [{ value: 'a@x', primary: true, type: 'work' }, { value: 'b@x' }],
    });
    const cleared = await store.patchUser(A, 'u_1', [
      { op: 'remove', path: 'externalId' },
      { op: 'remove', path: 'emails' },
    ]);
    expect(cleared).not.toHaveProperty('externalId');
    expect(cleared).not.toHaveProperty('emails');
  });

  it('pages by startIndex, count and cursor', async () => {
    const store = memoryDirectoryStore();
    for (const name of ['a', 'b', 'c']) {
      await store.putUser(A, user({ id: `u_${name}`, userName: name }));
    }
    expect(await store.findUsers(A, undefined, { count: 2 })).toMatchObject({
      totalResults: 3,
      startIndex: 1,
      itemsPerPage: 2,
      nextCursor: '2',
    });
    const second = await store.findUsers(A, undefined, {
      cursor: '2',
      count: 2,
    });
    expect(second).toMatchObject({ startIndex: 3, itemsPerPage: 1 });
    expect(second).not.toHaveProperty('nextCursor');
    expect(
      (await store.findUsers(A, undefined, { startIndex: 2 })).Resources.map(
        (item) => item.userName,
      ),
    ).toEqual(['b', 'c']);
    expect(
      await store.findUsers(A, undefined, { cursor: 'junk', count: 1 }),
    ).toMatchObject({ startIndex: 1, nextCursor: '1' });
    expect(
      await store.findUsers(A, undefined, { cursor: '', startIndex: 0 }),
    ).toMatchObject({ startIndex: 1, itemsPerPage: 3 });
    expect(
      await store.findUsers(A, undefined, { cursor: '-2', count: 1 }),
    ).toMatchObject({ startIndex: 1, itemsPerPage: 1, nextCursor: '1' });
    expect(
      (
        await store.findUsers(
          A,
          { op: 'eq', attribute: 'userName', value: 'b' },
          {},
        )
      ).Resources.map((item) => item.id),
    ).toEqual(['u_b']);
  });

  it('removes a deleted user from every group in the tenant', async () => {
    const store = memoryDirectoryStore();
    await store.putUser(A, user({ id: 'u_1' }));
    await store.putGroup(
      A,
      group({ id: 'g_1', members: [{ value: 'u_1' }, { value: 'u_2' }] }),
    );
    await store.putGroup(
      A,
      group({ id: 'g_2', externalId: 'x', members: [{ value: 'u_2' }] }),
    );
    await store.deleteUser(A, 'u_1');
    expect(await store.getUser(A, 'u_1')).toBeNull();
    expect((await store.getGroup(A, 'g_1'))?.members).toEqual([
      { value: 'u_2' },
    ]);
    expect((await store.getGroup(A, 'g_2'))?.members).toEqual([
      { value: 'u_2' },
    ]);
    expect((await store.groupsFor(A, 'u_2')).map((item) => item.id)).toEqual([
      'g_1',
      'g_2',
    ]);
  });
});

describe('memoryDirectoryStore groups', () => {
  it('assigns ids and enforces externalId uniqueness', async () => {
    const store = memoryDirectoryStore();
    const first = await store.putGroup(A, group({ externalId: 'x' }));
    expect(first.id).toMatch(/^g_/u);
    expect(first.meta.resourceType).toBe('Group');
    await store.putGroup(A, group({ id: 'g_2' }));
    await expect(
      store.putGroup(A, group({ id: 'g_3', externalId: 'x' })),
    ).rejects.toMatchObject({
      message: 'externalId',
    });
    await expect(
      store.patchGroup(A, 'g_2', [
        { op: 'replace', path: 'externalId', value: 'x' },
      ]),
    ).rejects.toBeInstanceOf(DirectoryUniquenessError);
    await expect(
      store.putGroup(A, group({ id: first.id, externalId: 'x' })),
    ).resolves.toMatchObject({
      id: first.id,
    });
    expect(
      (
        await store.findGroups(
          A,
          { op: 'eq', attribute: 'externalId', value: 'x' },
          {},
        )
      ).Resources.length,
    ).toBe(1);
  });

  it('applies group patch operations', async () => {
    const store = memoryDirectoryStore();
    await store.putGroup(
      A,
      group({ id: 'g_1', externalId: 'x', members: [{ value: 'u_1' }] }),
    );
    const added = await store.patchGroup(A, 'g_1', [
      { op: 'replace', path: 'displayName', value: 'Platform' },
      { op: 'replace', path: 'displayName', value: 7 },
      { op: 'replace', path: 'externalId', value: 9 },
      { op: 'add', path: 'roles', value: ['admin', 3] },
      {
        op: 'add',
        path: 'members',
        value: [{ value: 'u_1' }, { value: 'u_2' }, null, { value: 1 }],
      },
      { op: 'add', path: 'title', value: 'ignored' },
    ]);
    expect({
      displayName: added.displayName,
      externalId: added.externalId,
      roles: added.roles,
      members: added.members,
    }).toEqual({
      displayName: 'Platform',
      externalId: undefined,
      roles: ['admin'],
      members: [{ value: 'u_1' }, { value: 'u_2' }],
    });
    const removed = await store.patchGroup(A, 'g_1', [
      { op: 'remove', path: 'members', value: [{ value: 'u_1' }] },
      { op: 'replace', path: 'roles', value: 'not-a-list' },
    ]);
    expect(removed.members).toEqual([{ value: 'u_2' }]);
    expect(removed).not.toHaveProperty('roles');
    const replaced = await store.patchGroup(A, 'g_1', [
      { op: 'replace', path: 'members', value: [{ value: 'u_9' }] },
      { op: 'replace', path: 'externalId', value: 'y' },
    ]);
    expect(replaced).toMatchObject({
      members: [{ value: 'u_9' }],
      externalId: 'y',
    });
    const emptied = await store.patchGroup(A, 'g_1', [
      { op: 'replace', path: 'members', value: 'nope' },
    ]);
    expect(emptied.members).toEqual([]);
  });

  it('deletes a group once', async () => {
    const store = memoryDirectoryStore();
    await store.putGroup(A, group({ id: 'g_1' }));
    await store.deleteGroup(A, 'g_1');
    const error: unknown = await store
      .deleteGroup(A, 'g_1')
      .catch((caught: unknown) => caught);
    expect(isDirectoryNotFoundError(error)).toBe(true);
    expect(error).toMatchObject({
      name: 'DirectoryNotFoundError',
      message: 'not found',
    });
  });
});
