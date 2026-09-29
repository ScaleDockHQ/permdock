import type {
  Credential,
  MembershipSource,
  Principal,
  SettingsSource,
  TenantSettings,
} from 'permdock';
import type { StoredCredential } from 'permdock/server';

import {
  allow,
  createPermDock,
  decideCredential,
  definePermissions,
  definePolicy,
  resource,
  role,
} from 'permdock';
import {
  apiKeyVerifier,
  generateApiKey,
  hashApiKey,
  subjectFromApiKey,
} from 'permdock/server';
import { testCredentialVerifier } from 'permdock/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from './support/postgres.ts';

import { startPostgres } from './support/postgres.ts';

const org = { organization: { field: 'orgId', memberOf: 'organization' } };
const permissions = definePermissions({
  repo: resource({ actions: ['read', 'write', 'delete'], relations: org }),
});
const { repo } = permissions;
const policy = definePolicy(
  { permissions },
  {
    subject: (user: Principal | null) => user,
    scopes: { organization: { key: 'orgId' } },
    roles: [
      role('admin', [allow(repo.read), allow(repo.write), allow(repo.delete)], {
        on: 'organization',
      }),
      role('developer', [allow(repo.read), allow(repo.write)], {
        on: 'organization',
      }),
    ],
  },
);

const SETUP = `
create table memberships (user_id text, org_id text, role text);
create table repos (id text primary key, "orgId" text);
create table api_keys (
  id text primary key,
  hash text not null,
  credential jsonb not null,
  revoked_at timestamptz
);
create table tenant_settings (tenant text primary key, settings jsonb not null);
insert into memberships values ('u_1', 'o_1', 'developer'), ('u_2', 'o_1', 'admin');
insert into repos values ('r_1', 'o_1'), ('r_2', 'o_1'), ('r_9', 'o_2');
insert into tenant_settings values ('o_1', '{"credentials":{"maxTtl":2592000}}');
`;

let db: Postgres;

const memberships: MembershipSource = {
  async membershipsFor(principal) {
    const result = await db.admin.query<{ org_id: string; role: string }>(
      'select org_id, role from memberships where user_id = $1',
      [principal.id],
    );
    return result.rows.map((row) => ({
      tenant: row.org_id,
      roles: [row.role],
    }));
  },
};

const settings: SettingsSource = {
  async settingsFor(tenant) {
    const result = await db.admin.query<{ settings: TenantSettings }>(
      'select settings from tenant_settings where tenant = $1',
      [tenant],
    );
    return result.rows[0]?.settings;
  },
};

const verifier = apiKeyVerifier({
  async find(id) {
    const result = await db.admin.query<StoredCredential>(
      'select hash, credential from api_keys where id = $1 and revoked_at is null',
      [id],
    );
    return result.rows[0];
  },
});

const resolveKey = subjectFromApiKey({
  verifier,
  permissions,
  settings,
  revoked: async (id) =>
    (
      await db.admin.query(
        'select 1 from api_keys where id = $1 and revoked_at is not null',
        [id],
      )
    ).rowCount !== 0,
});

async function store(
  credential: Credential,
  key = generateApiKey(credential.id),
): Promise<string> {
  await db.admin.query(
    'insert into api_keys (id, hash, credential) values ($1, $2, $3)',
    [credential.id, await hashApiKey(key), JSON.stringify(credential)],
  );
  return key;
}

async function repos(): Promise<readonly { id: string; orgId: string }[]> {
  return (
    await db.admin.query<{ id: string; orgId: string }>(
      'select id, "orgId" from repos order by id',
    )
  ).rows;
}

async function dockFor(key: string, tenant = 'o_1') {
  const subject = await resolveKey(key, { tenant });
  return createPermDock(
    policy,
    subject,
    subject.principal?.kind === 'service' ? {} : { memberships, tenant },
  );
}

async function creator(id: string) {
  return createPermDock(
    policy,
    { principal: { id, kind: 'user' }, context: {} },
    { memberships, tenant: 'o_1' },
  );
}

const DAY = 86_400;
const conformanceKey = generateApiKey('conformance');

beforeAll(async () => {
  db = await startPostgres([SETUP]);
  const now = Math.floor(Date.now() / 1000);
  await store(
    {
      v: 1,
      id: 'conformance',
      kind: 'user',
      principal: 'u_1',
      permissions: [{ permission: 'repo.read' }],
      createdBy: 'u_1',
      createdAt: now,
      expiresAt: now + DAY,
    },
    conformanceKey,
  );
});

afterAll(async () => {
  await db.stop();
});

describe('API keys stored as SHA-256 hashes in Postgres', () => {
  testCredentialVerifier(verifier, {
    key: conformanceKey,
    revoke: async () => {
      await db.admin.query(
        "update api_keys set revoked_at = now() where id = 'conformance'",
      );
    },
  });

  it('stores only the hash and finds the key by its id', async () => {
    const dock = await creator('u_1');
    const decision = await decideCredential(
      dock,
      {
        kind: 'user',
        id: 'key_user',
        permissions: [repo.read],
        expiresAt: Math.floor(Date.now() / 1000) + DAY,
      },
      { settings },
    );
    expect(decision.outcome).toBe('granted');
    if (decision.outcome !== 'granted') {
      return;
    }
    const key = await store(decision.credential);
    const row = await db.admin.query<{ hash: string; credential: unknown }>(
      "select hash, credential::text from api_keys where id = 'key_user'",
    );
    expect(row.rows[0]?.hash).toHaveLength(43);
    expect(JSON.stringify(row.rows[0])).not.toContain(key.slice(-43));
    const permdock = await dockFor(key);
    expect(permdock.filter(repo.read, await repos()).map((r) => r.id)).toEqual([
      'r_1',
      'r_2',
    ]);
    expect(permdock.filter(repo.write, await repos())).toEqual([]);
  });

  it('follows the owner live rights: a demotion reaches the key on the next request', async () => {
    const now = Math.floor(Date.now() / 1000);
    const key = await store({
      v: 1,
      id: 'key_demote',
      kind: 'user',
      principal: 'u_2',
      permissions: [{ permission: 'repo.delete' }],
      createdBy: 'u_2',
      createdAt: now,
      expiresAt: now + DAY,
    });
    const [r1] = await repos();
    expect((await dockFor(key)).can(repo.delete, r1)).toBe(true);
    await db.admin.query(
      "update memberships set role = 'developer' where user_id = 'u_2'",
    );
    expect((await dockFor(key)).can(repo.delete, r1)).toBe(false);
  });

  it('creates a service key inside the creator ceiling and the tenant policy', async () => {
    const developer = await creator('u_1');
    const expiresAt = Math.floor(Date.now() / 1000) + DAY;
    const tooWide = await decideCredential(
      developer,
      {
        kind: 'service',
        id: 'svc_wide',
        tenant: 'o_1',
        roles: ['admin'],
        permissions: [repo.delete],
        expiresAt,
      },
      { settings },
    );
    expect(tooWide).toMatchObject({
      outcome: 'denied',
      denials: [{ reason: 'exceeds-creator' }],
    });
    const tooLong = await decideCredential(
      developer,
      {
        kind: 'service',
        id: 'svc_long',
        tenant: 'o_1',
        roles: ['developer'],
        permissions: [repo.read],
        expiresAt: expiresAt + 90 * DAY,
      },
      { settings },
    );
    expect(tooLong).toMatchObject({
      denials: [{ reason: 'credential-policy', detail: { rule: 'ttl' } }],
    });
    const decision = await decideCredential(
      developer,
      {
        kind: 'service',
        id: 'svc_ci',
        principal: 'ci',
        tenant: 'o_1',
        roles: ['developer'],
        permissions: [{ permission: repo.write, ids: ['r_1'] }],
        expiresAt,
      },
      { settings },
    );
    expect(decision.outcome).toBe('granted');
    if (decision.outcome !== 'granted') {
      return;
    }
    const key = await store(decision.credential);
    const permdock = await dockFor(key);
    expect(permdock.subject.principal?.kind).toBe('service');
    expect(permdock.filter(repo.write, await repos()).map((r) => r.id)).toEqual(
      ['r_1'],
    );
    await db.admin.query(
      "update api_keys set revoked_at = now() where id = 'svc_ci'",
    );
    expect((await dockFor(key)).subject.principal).toBeNull();
  });

  it('refuses existing keys once the tenant tightens its policy', async () => {
    const now = Math.floor(Date.now() / 1000);
    const key = await store({
      v: 1,
      id: 'svc_tighten',
      kind: 'service',
      principal: 'nightly',
      tenant: 'o_1',
      roles: ['developer'],
      permissions: [{ permission: 'repo.read' }],
      createdBy: 'u_1',
      createdAt: now,
      expiresAt: now + 7 * DAY,
    });
    expect((await dockFor(key)).subject.principal?.id).toBe('nightly');
    await db.admin.query(
      `update tenant_settings set settings = '{"credentials":{"maxTtl":86400}}' where tenant = 'o_1'`,
    );
    expect((await dockFor(key)).subject.principal).toBeNull();
  });
});
