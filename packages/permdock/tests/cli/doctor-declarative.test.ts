import { afterAll, describe, expect, it } from 'vitest';

import type { PermDockConfig } from '../../src/cli/types.ts';

import { pd042, pd043 } from '../../src/cli/doctor-declarative.ts';
import { HOOK_MARKER } from '../../src/cli/markers.ts';
import { project, removeProjects } from './doctor-kit.ts';

afterAll(removeProjects);

const HOOK_CONFIG: PermDockConfig = {
  supabase: { hook: { memberships: [] } },
};
const CREATE =
  'create or replace function public.custom_access_token_hook(event jsonb) returns jsonb language sql as $$ select event $$;\n';
const GRANT =
  'grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;\n';
const HELPERS =
  'create or replace function public.permdock_has(p text) returns boolean language sql as $$ select true $$;\n';
const POLICY =
  'create policy "read" on posts for select using (public.permdock_has(\'post.read\'));\n';

describe('PD042 hook grants after db diff', () => {
  const declared = {
    'supabase/schemas/hook.sql': `${HOOK_MARKER} schema=public\n${CREATE}`,
  };

  it('needs a supabase.hook config and a hook declared under supabase/schemas', () => {
    const migrations = { 'supabase/migrations/001.sql': CREATE };
    expect(pd042(project({ ...declared, ...migrations }), {})).toEqual([]);
    expect(
      pd042(
        project({ 'supabase/schemas/hook.sql': CREATE, ...migrations }),
        HOOK_CONFIG,
      ),
    ).toEqual([]);
  });

  it('is silent when no migration creates the hook, or a later one grants it', () => {
    expect(
      pd042(
        project({ ...declared, 'supabase/migrations/001.sql': 'select 1;\n' }),
        HOOK_CONFIG,
      ),
    ).toEqual([]);
    expect(
      pd042(
        project({
          ...declared,
          'supabase/migrations/001.sql': CREATE,
          'supabase/migrations/002.sql': GRANT,
        }),
        HOOK_CONFIG,
      ),
    ).toEqual([]);
  });

  it('errors when the only grant sits in a comment', () => {
    const findings = pd042(
      project({
        ...declared,
        'supabase/migrations/001.sql': `${CREATE}-- ${GRANT}`,
      }),
      HOOK_CONFIG,
    );
    expect(findings.map((item) => [item.code, item.severity])).toEqual([
      ['PD042', 'error'],
    ]);
    expect(findings[0]?.message).toMatch(
      /^supabase\/migrations\/001\.sql creates custom_access_token_hook from supabase\/schemas/u,
    );
  });

  it('is silent under pg-delta, whose declarative sync keeps the grants', () => {
    expect(
      pd042(
        project({
          ...declared,
          'supabase/migrations/001.sql': CREATE,
          'supabase/config.toml': '[experimental.pgdelta]\nenabled = true\n',
        }),
        HOOK_CONFIG,
      ),
    ).toEqual([]);
  });
});

describe('PD043 schema_paths order', () => {
  it('is silent without supabase/schemas, or without a helpers file', () => {
    expect(pd043(project({}))).toEqual([]);
    expect(pd043(project({ 'supabase/schemas/a.sql': POLICY }))).toEqual([]);
  });

  it('uses the default glob without a config, a [db.migrations] section or a list', () => {
    const files = {
      'supabase/schemas/010_helpers.sql': HELPERS,
      'supabase/schemas/020_policies.sql': POLICY,
    };
    expect(pd043(project(files))).toEqual([]);
    expect(
      pd043(
        project({
          ...files,
          'supabase/config.toml': '[auth]\nenabled = true\n',
        }),
      ),
    ).toEqual([]);
    expect(
      pd043(
        project({
          ...files,
          'supabase/config.toml': '[db.migrations]\nenabled = true\n',
        }),
      ),
    ).toEqual([]);
    expect(
      pd043(
        project({
          ...files,
          'supabase/config.toml': '[db.migrations]\nschema_paths = []\n',
        }),
      ),
    ).toEqual([]);
  });

  it('is silent under pg-delta, which orders statements by their dependencies', () => {
    const cwd = project({
      'supabase/schemas/public/policies.sql': POLICY,
      'supabase/schemas/permdock/helpers.sql': HELPERS,
      'supabase/config.toml': `[experimental.pgdelta]\nenabled = true\n[db.migrations]\nschema_paths = ['./schemas/public/*.sql', './schemas/permdock/*.sql']\n`,
    });
    expect(pd043(cwd)).toEqual([]);
  });

  it('reads single-quoted paths and warns on a policy listed before the helpers', () => {
    const cwd = project({
      'supabase/schemas/010_helpers.sql': HELPERS,
      'supabase/schemas/020_policies.sql': POLICY,
      'supabase/schemas/notes.txt': POLICY,
      'supabase/config.toml': `[db.migrations]\nschema_paths = ['./schemas/020_*.sql', './schemas/*']\n`,
    });
    expect(pd043(cwd)).toEqual([
      {
        code: 'PD043',
        severity: 'warning',
        message:
          'supabase/schemas/020_policies.sql calls the PermDock helpers, but schema_paths applies it before supabase/schemas/010_helpers.sql, which defines them',
        fix: 'list supabase/schemas/010_helpers.sql earlier in [db.migrations] schema_paths, or give it a lower number, such as 056_permdock_helpers.sql before 060_policies.sql',
      },
    ]);
  });
});
