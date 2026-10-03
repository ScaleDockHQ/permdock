import { symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { DoctorFinding } from '../../src/cli/doctor-types.ts';
import type { PermDockConfig } from '../../src/cli/types.ts';

import {
  pd005,
  pd006,
  pd009,
  pd012,
  pd022,
  pd028,
} from '../../src/cli/doctor-project.ts';
import { sqlFiles } from '../../src/cli/files.ts';
import { project, removeProjects } from './doctor-kit.ts';

afterAll(removeProjects);

function messages(findings: readonly DoctorFinding[]): readonly string[] {
  return findings.map((item) => item.message);
}

const SKILL = '---\nname: permdock\n---\n';

describe('PD005 Agent Skills', () => {
  it('warns when skills are missing, then when only the lock is missing', () => {
    expect(messages(pd005(project({})))).toEqual([
      'Agent Skills are not installed',
    ]);
    expect(
      messages(pd005(project({ '.cursor/skills/permdock/SKILL.md': SKILL }))),
    ).toEqual(['skills lock is missing']);
    expect(
      pd005(
        project({
          '.claude/skills/permdock/SKILL.md': SKILL,
          '.permdock/skills-lock.json': '{}',
        }),
      ),
    ).toEqual([]);
  });
});

describe('PD006 TypeScript version', () => {
  const withTypescript = (manifest: string): string =>
    project({
      'package.json': '{"name":"app"}',
      'node_modules/typescript/package.json': manifest,
    });

  it.each([
    ['5.8.3', 'TypeScript 5.8.3 is below the supported matrix (5.9, 6, 7)'],
    ['4.9.5', 'TypeScript 4.9.5 is below the supported matrix (5.9, 6, 7)'],
    ['8.0.0', 'TypeScript 8.0.0 is not in the supported matrix (5.9, 6, 7)'],
  ])('errors on TypeScript %s', (version, message) => {
    const findings = pd006(withTypescript(JSON.stringify({ version })));
    expect(findings).toEqual([
      expect.objectContaining({ code: 'PD006', severity: 'error', message }),
    ]);
  });

  it.each(['5.9.2', '6.0.1', '7.0.0'])('accepts TypeScript %s', (version) => {
    expect(pd006(withTypescript(JSON.stringify({ version })))).toEqual([]);
  });

  it('errors when typescript cannot be loaded', () => {
    expect(messages(pd006(withTypescript('{')))).toEqual([
      'typescript is not installed',
    ]);
  });
});

describe('PD009 duplicate copies', () => {
  const manifest = '{"name":"permdock","version":"0.1.0"}';

  it('finds a nested second copy and skips dot folders, files and broken links', () => {
    const cwd = project({
      'node_modules/permdock/package.json': manifest,
      'node_modules/lib/node_modules/permdock/package.json': manifest,
      'node_modules/.bin/tool': '',
      'node_modules/README.md': '',
    });
    symlinkSync(
      path.join(cwd, 'missing'),
      path.join(cwd, 'node_modules/broken'),
    );
    expect(pd009(cwd)).toEqual([
      {
        code: 'PD009',
        severity: 'error',
        message:
          'duplicate permdock copies: node_modules/permdock, node_modules/lib/node_modules/permdock',
        fix: 'dedupe so only one permdock version is installed',
      },
    ]);
  });

  it('accepts one copy and stops past six levels', () => {
    expect(
      pd009(project({ 'node_modules/permdock/package.json': manifest })),
    ).toEqual([]);
    const deep = Array.from(
      { length: 7 },
      (_, index) => `node_modules/d${String(index)}`,
    ).join('/');
    expect(
      pd009(
        project({
          'node_modules/permdock/package.json': manifest,
          [`${deep}/node_modules/permdock/package.json`]: manifest,
        }),
      ),
    ).toEqual([]);
    expect(pd009(path.join(project({}), 'absent'))).toEqual([]);
  });
});

describe('PD012 draft pins', () => {
  it('warns on a document with drafts and no overlay, and skips missing ones', () => {
    const cwd = project({
      'stale.json': '{"x-permdock-catalog":{"drafts":{}}}',
      'overlay.json': '{"overlay":"1.1","drafts":{}}',
      'clean.json': '{}',
    });
    const config: PermDockConfig = {
      openapi: {
        doc: [
          './stale.json',
          './overlay.json',
          './clean.json',
          './absent.json',
        ],
      },
    };
    expect(messages(pd012(cwd, config))).toEqual([
      './stale.json carries a draft pin the CLI no longer emits',
    ]);
    expect(pd012(cwd, {})).toEqual([]);
  });
});

describe('sqlFiles', () => {
  it('reads a folder recursively, a glob as written, and sorts', () => {
    const cwd = project({
      'db/b.sql': '',
      'db/nested/a.sql': '',
      'db/notes.txt': '',
      'other/c.sql': '',
    });
    expect(
      sqlFiles(cwd, ['db', 'other/*.sql', 'other/*']).map((file) =>
        path.relative(cwd, file),
      ),
    ).toEqual(['db/b.sql', 'db/nested/a.sql', 'other/c.sql']);
  });

  it('keeps a file entry as written and entry order on request', () => {
    const cwd = project({
      'z/one.sql': '',
      'a/two.sql': '',
      'a/three.sql': '',
    });
    expect(
      sqlFiles(cwd, ['z/one.sql', 'a/*.sql'], { order: 'entry' }).map((file) =>
        path.relative(cwd, file),
      ),
    ).toEqual(['z/one.sql', 'a/three.sql', 'a/two.sql']);
  });
});

describe('PD022 security_invoker views', () => {
  it('is silent without an rls config or doctor.migrations', () => {
    const cwd = project({
      'supabase/migrations/001.sql': 'create view v as select 1;\n',
    });
    expect(pd022(cwd, {})).toEqual([]);
  });

  it('reads doctor.migrations, a redefinition, alter view and field companions', () => {
    const cwd = project({
      'sql/001.sql': `create view public.kept with (security_invoker = true) as select 1;
create view redefined with (security_invoker = true) as select 1;
create view fixed as select 1;
create view "public"."posts_visible_fields" as select 1;
comment on view "public"."posts_visible_fields" is 'permdock:field-companion public.posts_visible';
`,
      'sql/002.sql': `create or replace view redefined as select 2;
alter view if exists fixed set (security_invoker);
alter view kept set (check_option = local);
`,
    });
    expect(messages(pd022(cwd, { doctor: { migrations: ['sql'] } }))).toEqual([
      'view public.redefined in sql/002.sql is not security_invoker, so it reads past row level security',
    ]);
  });
});

describe('PD028 attrs and membership columns', () => {
  const attrs = { table: 'profiles', columns: ['region'] } as const;
  const config = (migrations: readonly string[]): PermDockConfig => ({
    doctor: { migrations },
    supabase: { hook: { memberships: [], attrs } },
  });

  it('reads only client roles on the attrs table, and table-level grants and revokes', () => {
    const cwd = project({
      'a/001.sql': `grant all privileges on public.profiles to service_role;
grant update on public.other to authenticated;
grant select on public.profiles to authenticated;
grant insert (bio), update (region, "locale") on table profiles to "authenticated", anon with grant option;
`,
      'b/001.sql': `grant all on profiles to public;
revoke all on profiles from public cascade;
`,
    });
    const plan = () => ({ table: 'profiles', columns: ['region'], errors: [] });
    expect(messages(pd028(cwd, config(['a']), plan))).toEqual([
      'attrs reads region from public.profiles, which the migrations let anon or authenticated insert or update: a user could set their own attribute',
    ]);
    expect(pd028(cwd, config(['b']), plan)).toEqual([]);
  });

  it('counts the Supabase default privileges on a public table until a migration revokes them', () => {
    const plan = () => ({ table: 'profiles', columns: ['region'], errors: [] });
    const create =
      'create table public.profiles (id uuid primary key, region text);\n';
    const cwd = project({
      'a/001.sql': create,
      'b/001.sql': `${create}revoke insert, update on public.profiles from anon, authenticated;\n`,
      'c/001.sql': `alter default privileges in schema public revoke all on tables from anon, authenticated;\n${create}`,
    });
    expect(messages(pd028(cwd, config(['a']), plan))).toEqual([
      'attrs reads region from public.profiles, which the migrations let anon or authenticated insert or update: a user could set their own attribute',
    ]);
    expect(pd028(cwd, config(['b']), plan)).toEqual([]);
    expect(pd028(cwd, config(['c']), plan)).toEqual([]);
  });

  it('reports the plan errors and skips the column check without a table', () => {
    const cwd = project({ 'a/001.sql': 'grant update on profiles to anon;\n' });
    const findings = pd028(cwd, config(['a']), () => ({
      columns: ['region'],
      errors: ['attrs lists user_metadata.plan, which is user-editable'],
    }));
    expect(findings).toEqual([
      {
        code: 'PD028',
        severity: 'error',
        message: 'attrs lists user_metadata.plan, which is user-editable',
        fix: 'list server-owned columns or app_metadata.<key> entries; user_metadata is user-editable',
      },
    ]);
  });

  it('returns only membership findings without attrs', () => {
    expect(pd028(project({}), {}, () => ({ columns: [], errors: [] }))).toEqual(
      [],
    );
  });
});
