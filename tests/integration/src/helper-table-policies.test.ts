import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'permdock/cli';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from './support/postgres.ts';

import { startPostgres } from './support/postgres.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/named-scopes');

// quote.read carries a row condition (`where: visible`); asset.read does not.
const SETUP = `
create schema permdock;
create function permdock.permitted_organization_ids(p_grant text) returns setof text
  language sql stable as $$ select null::text where false $$;
create schema storage;
create table storage.objects (name text not null);
alter table storage.objects enable row level security;
create schema realtime;
create table realtime.messages (topic text not null);
alter table realtime.messages enable row level security;
create policy "asset files" on storage.objects for select
  using (split_part(name, '/', 1) in (select permdock.permitted_organization_ids('asset.read')));
create policy "quote files" on storage.objects for select
  using (split_part(name, '/', 1) in (select permdock.permitted_organization_ids('quote.read')));
create policy "quote topics" on realtime.messages for select
  using (split_part(topic, ':', 2) in (select permdock.permitted_organization_ids('quote.read#2')));
`;

describe('rls verify --db and helper calls on storage and realtime', () => {
  let db: Postgres | undefined;
  let dir = '';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'permdock-helper-tables-'));
    writeFileSync(join(dir, 'fixtures.json'), '[]');
    db = await startPostgres([SETUP]);
  }, 120_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  it('reports PD037 for each policy that passes a row-conditioned key', async () => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    const result = await run(
      [
        'rls',
        'verify',
        '--db',
        db.uri,
        '--fixtures',
        join(dir, 'fixtures.json'),
      ],
      { cwd: FIXTURE },
    );
    expect(result.code).toBe(1);
    const lines = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('PD037'));
    expect(lines).toHaveLength(2);
    expect(result.stdout).toContain("storage.objects policy 'quote files'");
    expect(result.stdout).toContain("realtime.messages policy 'quote topics'");
    expect(result.stdout).not.toContain('asset files');
  });
});
