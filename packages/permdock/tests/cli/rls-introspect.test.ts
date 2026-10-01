import { describe, expect, it } from 'vitest';

import type { ActualRls } from '../../src/cli/rls-introspect.ts';

import {
  diffMixed,
  diffRls,
  expectedRls,
  qualified,
} from '../../src/cli/rls-introspect.ts';
import { run } from '../../src/cli/run.ts';

const SQL = `create or replace function "app".permdock_has(p_grant text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select true $$;
create or replace function "app".guard()
returns trigger
language plpgsql
as $$ begin return new; end $$;`;

const expected = expectedRls(
  [
    {
      name: 'post_select',
      table: 'post',
      command: 'select',
      effect: 'allow',
      roles: ['authenticated'],
      using: 'true',
    },
    {
      name: 'deny_post_delete',
      table: 'post',
      command: 'delete',
      effect: 'deny',
      roles: ['authenticated'],
      using: 'false',
    },
  ],
  SQL,
);

const clean: ActualRls = {
  policies: [
    {
      table: 'public.post',
      name: 'post_select',
      command: 'select',
      permissive: true,
      roles: ['authenticated'],
    },
    {
      table: 'public.post',
      name: 'deny_post_delete',
      command: 'delete',
      permissive: false,
      roles: ['authenticated'],
    },
  ],
  rlsEnabled: { 'public.post': true },
  grants: { 'public.post': { authenticated: ['select'] } },
  helpers: {
    'app.permdock_has': { securityDefiner: true, emptySearchPath: true },
  },
};

describe('rls verify --introspect', () => {
  it('expects the security definer helpers, table grants and policies generate writes', () => {
    expect(qualified('"app"."post"')).toBe('app.post');
    expect(expected.helpers).toEqual(['app.permdock_has']);
    expect(expected.tables).toEqual(['public.post']);
    expect(expected.grants).toEqual({
      'public.post': { anon: [], authenticated: ['select'] },
    });
    expect(diffRls(expected, clean)).toEqual([]);
  });

  it('names each difference', () => {
    expect(
      diffRls(expected, {
        ...clean,
        policies: [
          {
            table: 'public.post',
            name: 'deny_post_delete',
            command: 'all',
            permissive: true,
            roles: ['anon', 'authenticated'],
          },
        ],
        grants: { 'public.post': {} },
        helpers: {},
      }),
    ).toEqual([
      'public.post: policy post_select is missing',
      'public.post: policy deny_post_delete is for all, expected delete',
      'public.post: policy deny_post_delete is permissive, expected restrictive',
      'public.post: policy deny_post_delete applies to anon, authenticated, expected authenticated',
      'public.post: authenticated lacks select, so the policy answers 42501 instead of filtering',
      'app.permdock_has: helper is missing',
    ]);
    expect(diffRls(expected, { ...clean, rlsEnabled: {} })).toEqual([
      'public.post: table is missing',
    ]);
    expect(
      diffRls(
        expected,
        { ...clean, grants: { 'public.post': {} } },
        { columnGrants: true },
      ),
    ).toEqual([]);
  });

  it('needs --db', async () => {
    const result = await run(['rls', 'verify', '--introspect']);
    expect(result.code).toBe(2);
    expect(result.stderr + result.stdout).toContain(
      'rls verify --introspect needs --db',
    );
  });
});

describe('diffMixed', () => {
  const seed = {
    role: 'admin',
    permission: 'asset.update',
    grantKey: 'asset.update',
    scope: 'organization',
    effect: 'allow',
  } as const;
  const mixed = {
    schema: 'public',
    seeds: [seed],
    permissions: ['asset.update', 'quote.read'],
    rowConditions: ['quote.read'],
  };

  it('diffs seeds exactly and checks every hand-written policy key', () => {
    const result = diffMixed(mixed, {
      seeds: [
        { ...seed, grantKey: 'asset.delete', permission: 'asset.delete' },
      ],
      policies: [
        {
          table: 'public.asset',
          name: 'assets_update',
          expression:
            "(organization_id IN ( SELECT public.permitted_organization_ids('asset.update'::text)))",
        },
        {
          table: 'public.quote',
          name: 'quotes_select',
          expression:
            "(organization_id IN ( SELECT public.permitted_organization_ids('quote.read'::text)))",
        },
        {
          table: 'public.note',
          name: 'notes_select',
          expression: "public.permdock_has('note.read'::text)",
        },
      ],
      rlsTables: [
        'public.asset',
        'public.legacy',
        'public.note',
        'public.quote',
      ],
    });
    expect(result.drift).toEqual([
      'public.role_permissions: missing admin allow asset.update on organization',
      'public.role_permissions: unexpected admin allow asset.delete on organization',
      'public.quote: policy quotes_select passes quote.read, whose grants carry row conditions the helpers do not check: the policy grants more than the application does',
      'public.note: policy notes_select passes note.read, which the policy does not declare, so it always denies',
    ]);
    expect(result.info).toEqual([
      'public.legacy: no policy calls a PermDock helper',
    ]);
  });

  it('counts a key-less member helper call as coverage', () => {
    const result = diffMixed(mixed, {
      seeds: [seed],
      policies: [
        {
          table: 'public.asset',
          name: 'assets_select',
          expression:
            '(organization_id IN ( SELECT public.member_organization_ids()))',
        },
      ],
      rlsTables: ['public.asset'],
    });
    expect(result).toEqual({ drift: [], info: [] });
  });
});
