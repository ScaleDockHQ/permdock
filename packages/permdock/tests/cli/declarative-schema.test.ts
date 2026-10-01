import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { run } from '../../src/cli/run.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = join(HERE, '../fixtures/named-scopes.ts');
const SUPABASE = join(HERE, '../../src/supabase/index.ts');
const TMP = join(HERE, '../../tmp');
const OUT = 'supabase/schemas/identity/056_permdock_{part}.sql';
const GRANTS = 'supabase/migrations/20260101000000_permdock_grants.sql';

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function project(hook = true): string {
  mkdirSync(TMP, { recursive: true });
  const cwd = mkdtempSync(join(TMP, 'declarative-'));
  temps.push(cwd);
  writeFileSync(
    join(cwd, 'permdock.config.ts'),
    `import { fromJunction, fromTable } from ${JSON.stringify(SUPABASE)};
const memberships = [
  fromTable({ table: 'memberships', columns: { via: 'via', expiresAt: 'expires_at' } }),
  fromJunction({ table: 'contacts', scope: 'customer', id: 'customer_id', within: { organization: 'organization_id' }, roles: ['contact'], via: 'contact' }),
];
export default {
  permissions: ${JSON.stringify(POLICY)},
  policy: ${JSON.stringify(POLICY)},
  rls: { dialect: 'supabase', membershipSources: memberships },
  ${hook ? 'supabase: { hook: { memberships } },' : ''}
};
`,
  );
  return cwd;
}

const read = (cwd: string, rel: string) => readFileSync(join(cwd, rel), 'utf8');

const part = (name: string) => OUT.replace('{part}', name);

const generate = (cwd: string, extra: readonly string[] = []) =>
  run(
    [
      'rls',
      'generate',
      '--target',
      'sql',
      '--split',
      'helpers,policies,hook',
      '--out',
      OUT,
      '--grants-out',
      GRANTS,
      ...extra,
    ],
    { cwd },
  );

describe('rls generate --split and --grants-out', () => {
  it('writes helpers, policies and hook parts, and moves the auth admin grants out', async () => {
    const cwd = project();
    const result = await generate(cwd);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      `wrote ${part('helpers')}, ${part('policies')}, ${part('hook')}, ${GRANTS}`,
    );
    const helpers = read(cwd, part('helpers'));
    expect(helpers).toContain('function "public".permdock_has(');
    expect(helpers).toContain('function "public".member_organization_ids()');
    expect(helpers).not.toContain('create policy');
    const policies = read(cwd, part('policies'));
    expect(policies).toContain('create policy');
    expect(policies).not.toContain('create or replace function');
    const hook = read(cwd, part('hook'));
    expect(hook).toContain('custom_access_token_hook(event jsonb)');
    expect(hook).toContain(
      `-- the supabase_auth_admin grants are in ${GRANTS}`,
    );
    expect(hook).not.toContain('supabase_auth_admin;');
    const grants = read(cwd, GRANTS);
    expect(grants.split('\n', 1)[0]).toBe(
      '-- permdock:grants v1 schema=public',
    );
    expect(grants).toContain(
      'grant usage on schema "public" to supabase_auth_admin;',
    );
    expect(grants).toContain(
      'grant execute on function "public".custom_access_token_hook(jsonb) to supabase_auth_admin;',
    );
    expect(grants).toContain(
      'revoke execute on function "public".custom_access_token_hook(jsonb) from authenticated, anon, public;',
    );
    expect(grants).toContain('"permdock_auth_admin_read_memberships"');
    expect(grants).toContain('"permdock_auth_admin_read_version"');
    expect(`${helpers}${policies}${hook}${grants}`).not.toMatch(
      /service_role/iu,
    );
  });

  it('checks every part and names the one that drifted', async () => {
    const cwd = project();
    expect((await generate(cwd)).code).toBe(0);
    expect((await generate(cwd, ['--check'])).stdout).toContain(
      'rls generate up to date',
    );
    writeFileSync(join(cwd, GRANTS), '-- edited\n');
    rmSync(join(cwd, part('policies')));
    const drift = await generate(cwd, ['--check']);
    expect(drift.code).toBe(1);
    expect(drift.stdout).toContain(
      `rls generate drift: policies: missing ${part('policies')}`,
    );
    expect(drift.stdout).toContain(`rls generate drift: grants: ${GRANTS}`);
  });

  it('writes only the parts it is given, and prints the grants with -', async () => {
    const cwd = project();
    const result = await run(
      [
        'rls',
        'generate',
        '--split',
        'hook,helpers',
        '--out',
        OUT,
        '--grants-out',
        '-',
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(existsSync(join(cwd, part('policies')))).toBe(false);
    expect(read(cwd, part('hook'))).toContain(
      '-- the supabase_auth_admin grants are in a separate migration',
    );
    expect(result.stdout).toContain('-- permdock:grants v1 schema=public');
  });

  it('refuses a split without {part}, grants without the hook part, and a hook part without supabase.hook', async () => {
    const cwd = project(false);
    const noPart = await run(
      ['rls', 'generate', '--split', 'helpers,policies', '--out', 'rls.sql'],
      { cwd },
    );
    expect(noPart.code).toBe(2);
    expect(noPart.stdout).toContain('--split needs {part} in --out');
    const noHook = await run(
      [
        'rls',
        'generate',
        '--split',
        'helpers',
        '--out',
        OUT,
        '--grants-out',
        GRANTS,
      ],
      { cwd },
    );
    expect(noHook.code).toBe(2);
    expect(noHook.stdout).toContain('--grants-out needs the hook part');
    const plain = await run(['rls', 'generate', '--grants-out', GRANTS], {
      cwd,
    });
    expect(plain.code).toBe(2);
    const unconfigured = await run(
      ['rls', 'generate', '--split', 'hook', '--out', OUT],
      { cwd },
    );
    expect(unconfigured.code).toBe(2);
    expect(unconfigured.stdout).toContain('needs supabase.hook');
    const unknown = await run(
      ['rls', 'generate', '--split', 'helpers,views', '--out', OUT],
      { cwd },
    );
    expect(unknown.code).toBe(2);
    expect(unknown.stdout).toContain('takes helpers, policies and hook');
  });
});

describe('supabase hook generate --grants-out', () => {
  it('keeps the grants out of the hook file and checks both', async () => {
    const cwd = project();
    const args = [
      'supabase',
      'hook',
      'generate',
      '--out',
      'hook.sql',
      '--grants-out',
      GRANTS,
    ];
    const result = await run(args, { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`wrote hook.sql, ${GRANTS}`);
    expect(read(cwd, 'hook.sql')).not.toContain('supabase_auth_admin;');
    expect(read(cwd, GRANTS)).toContain('to supabase_auth_admin;');
    expect((await run([...args, '--check'], { cwd })).code).toBe(0);
    writeFileSync(join(cwd, GRANTS), '');
    const drift = await run([...args, '--check'], { cwd });
    expect(drift.code).toBe(1);
    expect(drift.stdout).toContain(`supabase hook drift: grants: ${GRANTS}`);
  });

  it('keeps the grants in one file without --grants-out', async () => {
    const cwd = project();
    expect(
      (
        await run(['supabase', 'hook', 'generate', '--out', 'hook.sql'], {
          cwd,
        })
      ).code,
    ).toBe(0);
    const sql = read(cwd, 'hook.sql');
    expect(sql).toContain('to supabase_auth_admin;');
    expect(sql.indexOf('create table if not exists')).toBeLessThan(
      sql.indexOf('"permdock_auth_admin_read_version"'),
    );
  });
});

type Finding = { readonly code: string; readonly message: string };

async function findings(cwd: string, only: string): Promise<Finding[]> {
  const result = await run(['doctor', '--json', '--only', only], { cwd });
  // SAFETY: doctor --json prints a DoctorReport
  return (JSON.parse(result.stdout) as { findings: Finding[] }).findings;
}

function put(cwd: string, file: string, text: string): void {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
}

describe('doctor on declarative schemas', () => {
  const DIFF = 'supabase/migrations/20260101000000_init.sql';
  const LATER = 'supabase/migrations/20260301000000_grants.sql';

  it('PD042: a db diff migration creates the hook and no later migration grants it', async () => {
    const cwd = project();
    expect((await generate(cwd)).code).toBe(0);
    expect(await findings(cwd, 'PD042')).toEqual([]);
    const hook = read(cwd, part('hook'));
    put(cwd, DIFF, hook);
    rmSync(join(cwd, GRANTS));
    const missing = await findings(cwd, 'PD042');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.message).toContain(
      `${DIFF} creates custom_access_token_hook`,
    );
    put(cwd, LATER, '');
    expect(await findings(cwd, 'PD042')).toHaveLength(1);
    await run(
      [
        'supabase',
        'hook',
        'generate',
        '--out',
        part('hook'),
        '--grants-out',
        LATER,
      ],
      { cwd },
    );
    expect(await findings(cwd, 'PD042')).toEqual([]);
    put(
      cwd,
      'supabase/migrations/20260401000000_recreate.sql',
      `drop function public.custom_access_token_hook(jsonb);\n${hook}`,
    );
    expect(await findings(cwd, 'PD042')).toHaveLength(1);
  });

  it('PD043: schema_paths applies a policy that calls the helpers before the helpers', async () => {
    const cwd = project();
    expect((await generate(cwd)).code).toBe(0);
    put(
      cwd,
      'supabase/schemas/public/060_customers.sql',
      'create policy "staff read" on public.customers for select to authenticated\n  using (organization_id in (select public.member_organization_ids()));\n',
    );
    expect(await findings(cwd, 'PD043')).toEqual([]);
    put(
      cwd,
      'supabase/config.toml',
      `[db.migrations]\nschema_paths = [\n  "./schemas/public/*.sql",\n  "./schemas/identity/*.sql",\n]\n\n[auth]\nenabled = true\n`,
    );
    const late = await findings(cwd, 'PD043');
    expect(late).toHaveLength(1);
    expect(late[0]?.message).toContain(
      `supabase/schemas/public/060_customers.sql calls the PermDock helpers, but schema_paths applies it before ${part('helpers')}`,
    );
    put(
      cwd,
      'supabase/config.toml',
      `[db.migrations]\nschema_paths = ["./schemas/public/*.sql"]\n`,
    );
    expect((await findings(cwd, 'PD043'))[0]?.message).toContain(
      'schema_paths in supabase/config.toml does not list it',
    );
  });
});
