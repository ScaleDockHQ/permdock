import type { Permission, Subject } from 'permdock';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPermDock, signCapability } from 'permdock';
import { run } from 'permdock/cli';
import { joseTokenSigner, subjectFromCapability } from 'permdock/jwt';
import { memoryReplayStore } from 'permdock/ssf';
import { exchangeCapability } from 'permdock/supabase';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from './support/postgres.ts';

import {
  files,
  permissions,
  policy,
  quotes,
} from '../fixtures/capabilities/policy.ts';
import { startPostgres } from './support/postgres.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/capabilities');
const APP = 'https://app.example.com';
const SUPABASE_SECRET = 'super-secret-jwt-token-with-at-least-32-characters';
const STAFF = '00000000-0000-4000-8000-00000000000a';

const PRIVATE_JWK = {
  crv: 'Ed25519',
  d: 'qco_Uh5slpzay2a-eC3woOxpC4DlS6aEzLtBRjrdtd4',
  x: '79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ',
  kty: 'OKP',
  kid: '2026-09',
  alg: 'Ed25519',
};
const { d: _d, ...PUBLIC_JWK } = PRIVATE_JWK;
const signer = joseTokenSigner({
  key: PRIVATE_JWK,
  alg: 'Ed25519',
  kid: '2026-09',
  issuer: APP,
});

const rows = (list: readonly { readonly id: string }[], extra: string[]) =>
  list
    .map(
      (row) =>
        `(${[
          row.id,
          // SAFETY: seed rows carry a string column for every key in `extra`
          ...extra.map((key) => (row as Record<string, string>)[key]),
        ]
          .map((value) => `'${value ?? ''}'`)
          .join(', ')})`,
    )
    .join(', ');

const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
create table public.quote (id text primary key, organization_id text not null, status text not null);
create table public.file (id text primary key, folder_id text not null);
insert into public.quote values ${rows(quotes, ['organization_id', 'status'])};
insert into public.file values ${rows(files, ['folder_id'])};
grant select, update on public.quote, public.file to authenticated, anon;
`;

type Link = Parameters<typeof signCapability>[0];

const inAnHour = (): number => Math.floor(Date.now() / 1000) + 3600;

function link(extra: Partial<Link> = {}): Promise<string> {
  return signCapability(
    {
      id: 'lnk_1',
      on: { resource: permissions.quote, id: 'q_1' },
      roles: ['guest'],
      expiresAt: inAnHour(),
      ...extra,
    },
    signer,
    { audience: APP },
  );
}

/** The `/portal/quotes?token=` handler: verify the link, then exchange it for a Supabase token. */
async function portal(
  url: string,
  options: Partial<Parameters<typeof subjectFromCapability>[1]> = {},
): Promise<{ readonly subject: Subject; readonly jwt: string | undefined }> {
  const token = new URL(url).searchParams.get('token');
  const subject = await subjectFromCapability(token, {
    jwks: { keys: [PUBLIC_JWK] },
    issuer: APP,
    audience: APP,
    ...options,
  });
  const jwt = await exchangeCapability(subject, {
    key: { secret: SUPABASE_SECRET },
    alg: 'HS256',
    ttl: 60,
  });
  return { subject, jwt };
}

function claimsOf(jwt: string | undefined): Record<string, unknown> {
  if (jwt === undefined) {
    return { role: 'anon' };
  }
  const payload = jwt.split('.')[1] ?? '';
  // SAFETY: a Supabase JWT payload is a JSON object of claims
  return JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
}

function allowed(
  subject: Subject,
  permission: Permission<string, unknown, 'instance'>,
  list: readonly { readonly id: string }[],
): string[] {
  const dock = createPermDock(policy, subject);
  if (dock instanceof Promise) {
    throw new TypeError('expected a synchronous instance');
  }
  return list.filter((row) => dock.can(permission, row)).map((row) => row.id);
}

describe('link capabilities through the Supabase exchange', () => {
  let db: Postgres | undefined;
  let generated = '';

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'permdock-links-'));
    const out = join(dir, 'rls.sql');
    const result = await run(
      ['rls', 'generate', '--target', 'sql', '--out', out],
      {
        cwd: FIXTURE,
      },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    generated = readFileSync(out, 'utf8');
    rmSync(dir, { recursive: true, force: true });
    db = await startPostgres([SETUP, generated]);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  async function visible(
    table: 'quote' | 'file',
    claims: Record<string, unknown>,
    role = claims['role'] === 'authenticated' ? 'authenticated' : 'anon',
  ): Promise<string[]> {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    return db.as(
      { role, settings: { 'request.jwt.claims': JSON.stringify(claims) } },
      async () =>
        (
          await db!.tester.query<{ readonly id: string }>(
            `select id from public.${table} order by id`,
          )
        ).rows.map((row) => row.id),
    );
  }

  it('generates the capability helper and anon policies, never service_role', () => {
    expect(generated).toContain('permdock_capability_ids(p_resource text');
    expect(generated).toContain('to anon');
    expect(generated).not.toMatch(/service_role/iu);
  });

  it.each([
    ['a guest link on a sent quote', {}],
    [
      'a guest link on a draft',
      { on: { resource: permissions.quote, id: 'q_3' } },
    ],
    ['a link narrowed to accept', { permissions: [permissions.quote.accept] }],
    [
      'a commenter link on a folder',
      { on: { resource: permissions.folder, id: 'f_1' }, roles: ['commenter'] },
    ],
  ] as const)('agrees with can() for %s', async (_label, extra) => {
    const { subject, jwt } = await portal(
      `${APP}/portal/quotes?token=${await link(extra)}`,
    );
    expect(jwt).toBeDefined();
    const claims = claimsOf(jwt);
    expect(claims['role']).toBe('anon');
    expect(await visible('quote', claims)).toEqual(
      allowed(subject, permissions.quote.read, quotes),
    );
    expect(await visible('file', claims)).toEqual(
      allowed(subject, permissions.file.read, files),
    );
  });

  it('lets the guest link read quote Q only, and accept it in code', async () => {
    const { subject, jwt } = await portal(
      `${APP}/portal/quotes?token=${await link()}`,
    );
    expect(await visible('quote', claimsOf(jwt))).toEqual(['q_1']);
    expect(allowed(subject, permissions.quote.accept, quotes)).toEqual(['q_1']);
    expect(allowed(subject, permissions.quote.update, quotes)).toEqual([]);
    await expect(
      db!.as(
        {
          role: 'anon',
          settings: { 'request.jwt.claims': JSON.stringify(claimsOf(jwt)) },
        },
        () => db!.tester.query(`update public.quote set status = 'sent'`),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('shows nothing for an expired, revoked or replayed link', async () => {
    const expired = await portal(
      `${APP}/portal/quotes?token=${await link({ expiresAt: Math.floor(Date.now() / 1000) - 60 })}`,
    );
    expect(expired.subject.principal).toBeNull();
    expect(expired.jwt).toBeUndefined();
    expect(await visible('quote', claimsOf(expired.jwt))).toEqual([]);

    const revoked = await portal(`${APP}/portal/quotes?token=${await link()}`, {
      revoked: (id) => id === 'lnk_1',
    });
    expect(revoked.jwt).toBeUndefined();

    const replay = memoryReplayStore();
    const url = `${APP}/portal/quotes?token=${await link({ once: true })}`;
    const first = await portal(url, { replay });
    expect(await visible('quote', claimsOf(first.jwt))).toEqual(['q_1']);
    const second = await portal(url, { replay });
    expect(second.jwt).toBeUndefined();
  });

  it('ignores a capability claim once the Supabase token has expired', async () => {
    const { jwt } = await portal(`${APP}/portal/quotes?token=${await link()}`);
    const claims = claimsOf(jwt);
    // SAFETY: the portal minted a capability link above, so the claim is an object
    const capability = claims['capability'] as Record<string, unknown>;
    expect(
      await visible('quote', {
        ...claims,
        capability: { ...capability, expiresAt: 1 },
      }),
    ).toEqual([]);
  });

  it('leaves staff access to the organization unchanged', async () => {
    expect(
      await visible('quote', {
        role: 'authenticated',
        sub: STAFF,
        tenant_id: 'T',
        memberships: [{ scope: 'organization', id: 'T', roles: ['staff'] }],
      }),
    ).toEqual(['q_1', 'q_2', 'q_3']);
  });
});
