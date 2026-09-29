import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { DirectoryEvent, TokenVerifier } from '../core/interfaces.ts';
import type { RevocationEvent } from '../core/revocations.ts';
import type { DirectoryChange } from './types.ts';

import { createPermDock } from '../core/permdock.ts';
import { memoryRevocationFeed } from '../core/revocations.ts';
import { memorySink } from '../core/sink.ts';
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from '../index.ts';
import { sha256Hex } from './auth.ts';
import { scimHandler } from './handler.ts';
import { tenantFromPath } from './route.ts';
import { directoryMembershipSource } from './source.ts';
import { memoryDirectoryStore } from './store.ts';
import {
  GROUP_SCHEMA,
  LIST_SCHEMA,
  PATCH_SCHEMA,
  ROLES_EXTENSION,
  USER_SCHEMA,
} from './types.ts';

const TOKEN = 'scim-secret';
const TENANT = 'o_acme';

function tokenOptions(): {
  readonly hash: 'sha256';
  readonly lookup: (tenant: string) => string | undefined;
} {
  const hash = sha256Hex(TOKEN);
  return {
    hash: 'sha256',
    lookup: (tenant) => (tenant === TENANT ? hash : undefined),
  };
}

function handler(
  extras: Partial<Parameters<typeof scimHandler>[0]> = {},
  store = memoryDirectoryStore(),
) {
  return {
    store,
    handle: scimHandler({
      store,
      tenant: (incoming) => tenantFromPath(incoming) || TENANT,
      token: tokenOptions(),
      ...extras,
    }),
  };
}

function request(path: string, init: RequestInit = {}, token = TOKEN): Request {
  const headers = new Headers(init.headers);
  if (token !== '') {
    headers.set('authorization', `Bearer ${token}`);
  }
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/scim+json');
  }
  return new Request(`https://app.example.com/scim/v2/${TENANT}${path}`, {
    ...init,
    headers,
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('memoryDirectoryStore', () => {
  it('round-trips users and groups and isolates tenants', async () => {
    const store = memoryDirectoryStore();
    const user = await store.putUser(TENANT, {
      id: '',
      userName: 'ada',
      active: true,
      meta: { created: '', lastModified: '' },
    });
    expect(user.id.startsWith('u_')).toBe(true);
    expect(await store.getUser(TENANT, user.id)).toEqual(user);
    expect(await store.getUser('o_other', user.id)).toBeNull();
    const group = await store.putGroup(TENANT, {
      id: 'g_editors',
      displayName: 'Editors',
      members: [{ value: user.id }],
      roles: ['editor'],
      meta: { created: '', lastModified: '' },
    });
    expect(await store.groupsFor(TENANT, user.id)).toEqual([group]);
    expect(await store.groupsFor('o_other', user.id)).toEqual([]);
  });

  it('rejects duplicate userName and externalId in a tenant', async () => {
    const store = memoryDirectoryStore();
    await store.putUser(TENANT, {
      id: 'u1',
      userName: 'ada',
      externalId: '00u1',
      active: true,
      meta: { created: '', lastModified: '' },
    });
    await expect(
      store.putUser(TENANT, {
        id: 'u2',
        userName: 'ada',
        active: true,
        meta: { created: '', lastModified: '' },
      }),
    ).rejects.toMatchObject({ code: 'uniqueness' });
    await expect(
      store.putUser(TENANT, {
        id: 'u3',
        userName: 'other',
        externalId: '00u1',
        active: true,
        meta: { created: '', lastModified: '' },
      }),
    ).rejects.toMatchObject({ code: 'uniqueness' });
    const copy = await store.putUser('o_other', {
      id: 'u1',
      userName: 'ada',
      externalId: '00u1',
      active: true,
      meta: { created: '', lastModified: '' },
    });
    expect(copy.userName).toBe('ada');
  });

  it('matches `pr` only on a non-empty value (RFC 7644 §3.4.2.2)', async () => {
    const store = memoryDirectoryStore();
    for (const [id, members] of [
      ['g_full', [{ value: 'u1' }]],
      ['g_empty', []],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- order is the page order
      await store.putGroup(TENANT, {
        id,
        displayName: id,
        members,
        meta: { created: '', lastModified: '' },
      });
    }
    await store.putUser(TENANT, {
      id: 'u_blank',
      userName: 'blank',
      externalId: '',
      active: true,
      meta: { created: '', lastModified: '' },
    });
    const groups = await store.findGroups(
      TENANT,
      { op: 'pr', attribute: 'members.value' },
      {},
    );
    expect(groups.Resources.map((group) => group.id)).toEqual(['g_full']);
    const users = await store.findUsers(
      TENANT,
      { op: 'pr', attribute: 'externalId' },
      {},
    );
    expect(users.Resources).toEqual([]);
  });
});

describe('directoryMembershipSource', () => {
  it('returns tenant memberships via groups and nothing for inactive users', async () => {
    const store = memoryDirectoryStore();
    const user = await store.putUser(TENANT, {
      id: 'u_ada',
      userName: 'ada',
      externalId: '00u1',
      active: true,
      meta: { created: '', lastModified: '' },
    });
    await store.putGroup(TENANT, {
      id: 'g_editors',
      displayName: 'Editors',
      members: [{ value: user.id }],
      roles: ['editor', 'superadmin'],
      meta: { created: '', lastModified: '' },
    });
    const dropped: string[] = [];
    const source = directoryMembershipSource(store, {
      assignable: ['editor'],
      onUnknownRole: (name) => {
        dropped.push(name);
      },
    });
    expect(
      await source.membershipsFor({ id: '00u1' }, { tenant: TENANT }),
    ).toEqual([
      {
        tenant: TENANT,
        roles: ['editor'],
        via: 'group:g_editors',
      },
    ]);
    expect(dropped).toEqual(['superadmin']);
    await store.patchUser(TENANT, user.id, [
      { op: 'replace', path: 'active', value: false },
    ]);
    expect(
      await source.membershipsFor({ id: '00u1' }, { tenant: TENANT }),
    ).toEqual([]);
  });
});

describe('scimHandler', () => {
  it('rejects missing or wrong bearer without a body', async () => {
    const { handle } = handler();
    const missing = await handle(request('/Users', {}, ''));
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
    expect(await missing.text()).toBe('');
    const wrong = await handle(request('/Users', {}, 'nope'));
    expect(wrong.status).toBe(401);
  });

  it('forbids an unresolved tenant and never reads tenant from the body', async () => {
    const store = memoryDirectoryStore();
    const handle = scimHandler({
      store,
      tenant: () => '',
      token: tokenOptions(),
    });
    const response = await handle(
      new Request('https://app.example.com/scim/v2/Users', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/scim+json',
        },
        body: JSON.stringify({
          schemas: [USER_SCHEMA],
          userName: 'ada',
          tenant: TENANT,
        }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it('creates, lists, patches and deactivates a user', async () => {
    const sink = memorySink();
    const { handle, store } = handler({ sink });
    const created = await handle(
      request('/Users', {
        method: 'POST',
        body: JSON.stringify({
          schemas: [USER_SCHEMA],
          userName: 'ada',
          externalId: '00u1',
          active: true,
        }),
      }),
    );
    expect(created.status).toBe(201);
    const user = await json(created);
    expect(user.userName).toBe('ada');
    expect(created.headers.get('content-type')).toBe('application/scim+json');
    const listed = await json(
      await handle(request('/Users?filter=userName eq "ada"')),
    );
    expect(listed.schemas).toEqual([LIST_SCHEMA]);
    expect(listed.totalResults).toBe(1);
    const patched = await handle(
      request(`/Users/${String(user.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          schemas: [PATCH_SCHEMA],
          Operations: [{ op: 'replace', path: 'active', value: 'False' }],
        }),
      }),
    );
    expect(patched.status).toBe(200);
    expect((await json(patched)).active).toBe(false);
    const events = sink.events().filter((event) => event.type === 'directory');
    expect(events).toHaveLength(2);
    expect((events[1] as DirectoryEvent).active).toBe(false);
    expect(await store.getUser(TENANT, String(user.id))).toMatchObject({
      active: false,
    });
  });

  it('stores group roles from the extension and maps members', async () => {
    const { handle, store } = handler({
      assignable: ['editor'],
    });
    const user = await json(
      await handle(
        request('/Users', {
          method: 'POST',
          body: JSON.stringify({
            schemas: [USER_SCHEMA],
            userName: 'ada',
            externalId: '00u1',
          }),
        }),
      ),
    );
    const group = await json(
      await handle(
        request('/Groups', {
          method: 'POST',
          body: JSON.stringify({
            schemas: [GROUP_SCHEMA, ROLES_EXTENSION],
            displayName: 'Editors',
            members: [{ value: user.id }],
            [ROLES_EXTENSION]: { roles: ['editor'] },
          }),
        }),
      ),
    );
    expect(group[ROLES_EXTENSION]).toEqual({ roles: ['editor'] });
    const source = directoryMembershipSource(store, { assignable: ['editor'] });
    expect(
      await source.membershipsFor({ id: '00u1' }, { tenant: TENANT }),
    ).toEqual([
      {
        tenant: TENANT,
        roles: ['editor'],
        via: `group:${String(group.id)}`,
      },
    ]);
  });

  it('emits a membership event per affected group member', async () => {
    const sink = memorySink();
    const { handle } = handler({ sink });
    const user = await json(
      await handle(
        request('/Users', {
          method: 'POST',
          body: JSON.stringify({
            schemas: [USER_SCHEMA],
            userName: 'ada',
            externalId: '00u1',
          }),
        }),
      ),
    );
    const group = await json(
      await handle(
        request('/Groups', {
          method: 'POST',
          body: JSON.stringify({
            schemas: [GROUP_SCHEMA, ROLES_EXTENSION],
            displayName: 'Editors',
            members: [{ value: user.id }],
            [ROLES_EXTENSION]: { roles: ['editor'] },
          }),
        }),
      ),
    );
    const added = sink.events().filter((event) => event.type === 'membership');
    expect(added).toEqual([
      expect.objectContaining({
        type: 'membership',
        source: 'scim',
        operation: 'added',
        principal: { id: user.id },
        scope: 'tenant',
        id: TENANT,
        via: `group:${String(group.id)}`,
        roles: { added: ['editor'], removed: [] },
      }),
    ]);
    await handle(request(`/Groups/${String(group.id)}`, { method: 'DELETE' }));
    const removed = sink
      .events()
      .filter(
        (event) => event.type === 'membership' && event.operation === 'removed',
      );
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({
      principal: { id: user.id },
      roles: { added: [], removed: ['editor'] },
    });
  });

  it('normalises Okta, Entra and Google patch dialects', async () => {
    const { handle } = handler();
    const user = await json(
      await handle(
        request('/Users', {
          method: 'POST',
          body: JSON.stringify({
            schemas: [USER_SCHEMA],
            userName: 'ada',
            externalId: '00u1',
          }),
        }),
      ),
    );
    const group = await json(
      await handle(
        request('/Groups', {
          method: 'POST',
          body: JSON.stringify({
            schemas: [GROUP_SCHEMA],
            displayName: 'Editors',
            members: [],
          }),
        }),
      ),
    );
    const entra = await handle(
      request(`/Groups/${String(group.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          schemas: [PATCH_SCHEMA],
          Operations: [
            {
              op: 'Add',
              path: `members[value eq "${String(user.id)}"]`,
              value: [{ value: user.id }],
            },
          ],
        }),
      }),
    );
    expect(entra.status).toBe(200);
    expect((await json(entra)).members).toEqual([{ value: user.id }]);
    const okta = await handle(
      request(`/Groups/${String(group.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          schemas: [PATCH_SCHEMA],
          Operations: [
            { op: 'remove', path: `members[value eq "${String(user.id)}"]` },
          ],
        }),
      }),
    );
    expect((await json(okta)).members).toEqual([]);
    const google = await handle(
      request(`/Users/${String(user.id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          schemas: [USER_SCHEMA],
          userName: 'ada',
          externalId: '00u1',
          active: false,
        }),
      }),
    );
    expect((await json(google)).active).toBe(false);
  });

  it('pages by index and cursor and advertises discovery', async () => {
    const { handle } = handler();
    for (const name of ['a', 'b', 'c']) {
      await handle(
        request('/Users', {
          method: 'POST',
          body: JSON.stringify({ schemas: [USER_SCHEMA], userName: name }),
        }),
      );
    }
    const first = await json(
      await handle(request('/Users?startIndex=1&count=2')),
    );
    expect(first.itemsPerPage).toBe(2);
    expect(first.totalResults).toBe(3);
    expect(typeof first.nextCursor).toBe('string');
    const second = await json(
      await handle(
        request(`/Users?cursor=${String(first.nextCursor)}&count=2`),
      ),
    );
    expect(second.Resources).toHaveLength(1);
    const config = await json(await handle(request('/ServiceProviderConfig')));
    expect(config.pagination).toEqual({ cursor: true, index: true });
    const types = await json(await handle(request('/ResourceTypes')));
    expect(Array.isArray(types)).toBe(true);
    const schema = await json(
      await handle(request(`/Schemas/${ROLES_EXTENSION}`)),
    );
    expect(schema.id).toBe(ROLES_EXTENSION);
  });

  it('accepts an RFC 7523 verifier and rejects a tenant-claim mismatch', async () => {
    const store = memoryDirectoryStore();
    const verifier: TokenVerifier = {
      async verify(token, expectations) {
        if (token !== 'jwt-ok' && token !== 'jwt-wrong') {
          return { ok: false, reason: 'invalid-token', cause: 'malformed' };
        }
        if (expectations.audience !== 'https://app.example.com/scim/v2') {
          return {
            ok: false,
            reason: 'invalid-token',
            cause: 'wrong-audience',
          };
        }
        return {
          ok: true,
          claims: {
            sub: 'relay',
            tenant: token === 'jwt-ok' ? TENANT : 'o_other',
            iss: 'https://cloud.permdock.dev',
          },
          header: { alg: 'Ed25519' },
        };
      },
    };
    const handle = scimHandler({
      store,
      tenant: TENANT,
      audience: 'https://app.example.com/scim/v2',
      verifier,
    });
    const ok = await handle(
      new Request('https://app.example.com/scim/v2/Users', {
        headers: { authorization: 'Bearer jwt-ok' },
      }),
    );
    expect(ok.status).toBe(200);
    const mismatch = await handle(
      new Request('https://app.example.com/scim/v2/Users', {
        headers: { authorization: 'Bearer jwt-wrong' },
      }),
    );
    expect(mismatch.status).toBe(403);
  });

  it('returns 409 on a duplicate userName and 404 on a missing user', async () => {
    const { handle } = handler();
    await handle(
      request('/Users', {
        method: 'POST',
        body: JSON.stringify({ schemas: [USER_SCHEMA], userName: 'ada' }),
      }),
    );
    const duplicate = await handle(
      request('/Users', {
        method: 'POST',
        body: JSON.stringify({ schemas: [USER_SCHEMA], userName: 'ada' }),
      }),
    );
    expect(duplicate.status).toBe(409);
    expect((await json(duplicate)).scimType).toBe('uniqueness');
    const missing = await handle(request('/Users/missing'));
    expect(missing.status).toBe(404);
  });

  it('deletes users and groups and supports and/or filters', async () => {
    const { handle } = handler();
    const first = await json(
      await handle(
        request('/Users', {
          method: 'POST',
          body: JSON.stringify({
            schemas: [USER_SCHEMA],
            userName: 'ada',
            externalId: '00u1',
          }),
        }),
      ),
    );
    await handle(
      request('/Users', {
        method: 'POST',
        body: JSON.stringify({ schemas: [USER_SCHEMA], userName: 'grace' }),
      }),
    );
    const filtered = await json(
      await handle(
        request('/Users?filter=userName eq "ada" or userName eq "grace"'),
      ),
    );
    expect(filtered.totalResults).toBe(2);
    const narrowed = await json(
      await handle(
        request('/Users?filter=userName eq "ada" and externalId eq "00u1"'),
      ),
    );
    expect(narrowed.totalResults).toBe(1);
    const group = await json(
      await handle(
        request('/Groups', {
          method: 'POST',
          body: JSON.stringify({
            schemas: [GROUP_SCHEMA],
            displayName: 'Editors',
            members: [{ value: first.id }],
          }),
        }),
      ),
    );
    expect(
      (
        await handle(
          request(`/Users/${String(first.id)}`, { method: 'DELETE' }),
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await handle(
          request(`/Groups/${String(group.id)}`, { method: 'DELETE' }),
        )
      ).status,
    ).toBe(204);
  });

  it('feeds memberships into createPermDock so deprovisioning denies', async () => {
    const store = memoryDirectoryStore();
    const user = await store.putUser(TENANT, {
      id: 'u_ada',
      userName: 'ada',
      externalId: 'u_ada',
      active: true,
      meta: { created: '', lastModified: '' },
    });
    await store.putGroup(TENANT, {
      id: 'g_editors',
      displayName: 'Editors',
      members: [{ value: user.id }],
      roles: ['editor'],
      meta: { created: '', lastModified: '' },
    });
    const Post = z.object({
      id: z.string(),
      orgId: z.string(),
    });
    const permissions = definePermissions({
      post: resource(Post, {
        id: 'id',
        actions: ['read'],
        relations: { org: { field: 'orgId', memberOf: 'tenant' } },
      }),
    });
    const policy = definePolicy(permissions, {
      roles: [role('editor', [allow(permissions.post.read)], { on: 'tenant' })],
      scopes: { tenant: { key: 'orgId' } },
      subject: (row: { readonly id: string } | null) =>
        row === null ? null : { id: row.id },
    });
    const granted = await createPermDock(
      policy,
      { id: 'u_ada' },
      {
        tenant: TENANT,
        memberships: directoryMembershipSource(store, {
          assignable: ['editor'],
        }),
      },
    );
    expect(
      granted.can(permissions.post.read, { id: 'p1', orgId: TENANT }),
    ).toBe(true);
    await store.patchUser(TENANT, user.id, [
      { op: 'replace', path: 'active', value: false },
    ]);
    const denied = await createPermDock(
      policy,
      { id: 'u_ada' },
      {
        tenant: TENANT,
        memberships: directoryMembershipSource(store, {
          assignable: ['editor'],
        }),
      },
    );
    expect(denied.can(permissions.post.read, { id: 'p1', orgId: TENANT })).toBe(
      false,
    );
  });
});

describe('scimHandler revocations', () => {
  it('publishes session-revoked for id, userName and externalId on deactivate and delete', async () => {
    const feed = memoryRevocationFeed();
    const seen: RevocationEvent[] = [];
    const changes: DirectoryChange[] = [];
    feed.subscribe((event) => {
      seen.push(event);
    });
    const { handle } = handler({
      revocations: feed,
      onChange: (change) => {
        changes.push(change);
      },
    });
    const user = await json(
      await handle(
        request('/Users', {
          method: 'POST',
          body: JSON.stringify({
            schemas: [USER_SCHEMA],
            userName: 'ada',
            externalId: '00u1',
            active: true,
          }),
        }),
      ),
    );
    const id = String(user.id);
    const expected = (kind: RevocationEvent['kind']): RevocationEvent[] =>
      [id, 'ada', '00u1']
        .map((principal) => ({ principal, tenant: TENANT, kind }))
        .toSorted((a, b) => a.principal.localeCompare(b.principal));
    const sorted = (): RevocationEvent[] =>
      seen.toSorted((a, b) => a.principal.localeCompare(b.principal));
    expect(sorted()).toEqual(expected('changed'));

    seen.length = 0;
    await handle(
      request(`/Users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          schemas: [PATCH_SCHEMA],
          Operations: [{ op: 'replace', path: 'active', value: false }],
        }),
      }),
    );
    expect(sorted()).toEqual(expected('session-revoked'));

    seen.length = 0;
    await handle(
      request(`/Users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          schemas: [PATCH_SCHEMA],
          Operations: [{ op: 'replace', path: 'active', value: true }],
        }),
      }),
    );
    expect(sorted()).toEqual(expected('changed'));

    seen.length = 0;
    const deleted = await handle(request(`/Users/${id}`, { method: 'DELETE' }));
    expect(deleted.status).toBe(204);
    expect(sorted()).toEqual(expected('session-revoked'));
    expect(changes.map((change) => change.kind)).toEqual([
      'changed',
      'session-revoked',
      'changed',
      'session-revoked',
    ]);
    expect(changes.at(-1)).toEqual({
      tenant: TENANT,
      userIds: [id],
      kind: 'session-revoked',
    });
  });

  it('keeps the IdP write successful when the feed throws', async () => {
    const { handle } = handler({
      revocations: {
        subscribe: () => () => undefined,
        revoke: () => {
          throw new Error('down');
        },
      },
    });
    const created = await handle(
      request('/Users', {
        method: 'POST',
        body: JSON.stringify({ schemas: [USER_SCHEMA], userName: 'ada' }),
      }),
    );
    expect(created.status).toBe(201);
  });
});
