import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { RlsSqlContext } from '../../src/cli/rls-sql.ts';

import { compileGrants } from '../../src/cli/rls-compile.ts';
import {
  arrayColumnsOf,
  claimPath,
  columnTypesOf,
  compileConditionSql,
  contextRefs,
} from '../../src/cli/rls-sql.ts';
import { scopeList } from '../../src/core/scopes.ts';
import {
  allow,
  context,
  definePermissions,
  definePolicy,
  principal,
  resource,
  role,
} from '../../src/index.ts';

const base: RlsSqlContext = {
  dialect: 'supabase',
  tenantClaim: 'tenant_id',
  scopes: scopeList(undefined),
  gucPrefix: 'app',
};

const typed: RlsSqlContext = {
  ...base,
  columnTypes: {
    clearance: 'numeric',
    archived: 'boolean',
    openedAt: 'timestamptz',
    ownerId: 'uuid',
  },
};

describe('nested claim paths', () => {
  it('walks every segment with -> and reads the last with ->>', () => {
    const condition = {
      op: 'eq',
      field: 'region',
      value: { ref: 'principal.claims.attrs.region' },
    } as const;
    expect(compileConditionSql(condition, base)).toBe(
      `"region" = ((select auth.jwt()) -> 'attrs' ->> 'region')`,
    );
    expect(compileConditionSql(condition, { ...base, dialect: 'neon' })).toBe(
      `"region" = ((select auth.session()) -> 'attrs' ->> 'region')`,
    );
    expect(compileConditionSql(condition, { ...base, dialect: 'guc' })).toBe(
      `"region" = (nullif(current_setting('app.attrs', true), '')::jsonb ->> 'region')`,
    );
  });

  it('keeps a one-segment claim on the flat form', () => {
    expect(
      compileConditionSql(
        { op: 'eq', field: 'plan', value: { ref: 'principal.claim.plan' } },
        { ...base, dialect: 'guc' },
      ),
    ).toBe(`"plan" = current_setting('app.plan', true)`);
  });

  it('checks every segment against the prototype-key blocklist and the name rule', () => {
    expect(claimPath('principal.claims.attrs.region')).toEqual([
      'attrs',
      'region',
    ]);
    expect(claimPath('principal.id')).toBeUndefined();
    for (const ref of [
      'principal.claims.attrs.__proto__',
      'principal.claims.constructor.x',
      'principal.claims.attrs.prototype',
      "principal.claims.attrs.re'gion",
      'principal.claims.a.b.c.d.e.f.g.h.i',
    ]) {
      expect(() => claimPath(ref)).toThrow(/claim/u);
    }
  });
});

describe('claims cast to the column type', () => {
  it('casts numbers and booleans only when the claim has that JSON kind', () => {
    expect(
      compileConditionSql(
        {
          op: 'gte',
          field: 'clearance',
          value: { ref: 'principal.claims.attrs.clearance' },
        },
        typed,
      ),
    ).toBe(
      `"clearance" >= (case when jsonb_typeof(((select auth.jwt()) -> 'attrs' -> 'clearance')) = 'number' then ((select auth.jwt()) -> 'attrs' ->> 'clearance')::numeric end)`,
    );
    expect(
      compileConditionSql(
        { op: 'eq', field: 'archived', value: { ref: 'principal.claims.ro' } },
        typed,
      ),
    ).toBe(
      `"archived" = (case when jsonb_typeof(((select auth.jwt()) -> 'ro')) = 'boolean' then ((select auth.jwt()) ->> 'ro')::boolean end)`,
    );
  });

  it('casts the text form for dates and uuids', () => {
    expect(
      compileConditionSql(
        {
          op: 'lt',
          field: 'openedAt',
          value: { ref: 'principal.claims.since' },
        },
        typed,
      ),
    ).toBe(`"openedAt" < (((select auth.jwt()) ->> 'since')::timestamptz)`);
    expect(
      compileConditionSql(
        { op: 'eq', field: 'ownerId', value: { ref: 'principal.claims.sub' } },
        typed,
      ),
    ).toBe(`"ownerId" = (((select auth.jwt()) ->> 'sub')::uuid)`);
  });

  it('casts a flat guc setting as is', () => {
    expect(
      compileConditionSql(
        {
          op: 'gt',
          field: 'clearance',
          value: { ref: 'principal.claims.clearance' },
        },
        { ...typed, dialect: 'guc' },
      ),
    ).toBe(`"clearance" > (current_setting('app.clearance', true)::numeric)`);
  });

  it('reads column types from the resource JSON Schema', () => {
    const Doc = z.object({
      id: z.uuid(),
      region: z.string(),
      clearance: z.number().int(),
      score: z.number().nullable(),
      archived: z.boolean(),
      openedAt: z.iso.datetime(),
      day: z.iso.date(),
      tags: z.array(z.string()),
    });
    // SAFETY: Zod 4 schemas implement Standard JSON Schema, so ~standard carries jsonSchema.
    expect(
      columnTypesOf(
        (
          Doc['~standard'] as unknown as {
            readonly jsonSchema: { readonly output: () => unknown };
          }
        ).jsonSchema.output(),
      ),
    ).toEqual({
      id: 'uuid',
      clearance: 'numeric',
      score: 'numeric',
      archived: 'boolean',
      openedAt: 'timestamptz',
      day: 'date',
    });
    expect(columnTypesOf(null)).toEqual({});
    expect(
      columnTypesOf({
        properties: { a: { anyOf: [{ type: 'integer' }, { type: 'null' }] } },
      }),
    ).toEqual({ a: 'numeric' });
  });
});

describe('in and notIn against an array claim', () => {
  const list = (type: string, cast: string): string =>
    `array(select (e #>> '{}')${cast} from jsonb_array_elements(case when jsonb_typeof(((select auth.jwt()) -> 'attrs' -> 'regions')) = 'array' then ((select auth.jwt()) -> 'attrs' -> 'regions') else '[]'::jsonb end) e where jsonb_typeof(e) = '${type}')`;

  it('builds the array once per statement and compares with any', () => {
    expect(
      compileConditionSql(
        {
          op: 'in',
          field: 'region',
          value: { ref: 'principal.claims.attrs.regions' },
        },
        base,
      ),
    ).toBe(`"region" = any (${list('string', '')})`);
  });

  it('keeps notIn false for a null column, as in memory', () => {
    expect(
      compileConditionSql(
        {
          op: 'notIn',
          field: 'clearance',
          value: { ref: 'principal.claims.attrs.regions' },
        },
        typed,
      ),
    ).toBe(
      `("clearance" is not null and not ("clearance" = any (${list('number', '::numeric')})))`,
    );
  });

  it('still rejects in against a ref that is not a claim', () => {
    expect(() =>
      compileConditionSql(
        { op: 'in', field: 'region', value: { ref: 'principal.id' } },
        base,
      ),
    ).toThrow(/non-portable in/u);
  });
});

describe('request context in RLS', () => {
  const Doc = z.object({
    id: z.string(),
    region: z.string(),
    clearance: z.number().int(),
  });
  const permissions = definePermissions({
    doc: resource(Doc, { actions: ['read', 'update'] }),
  });
  const policy = definePolicy(permissions, {
    roles: [
      role('analyst', [
        allow(permissions.doc.read, {
          where: {
            region: principal['claims']['attrs']['region'],
            clearance: { lte: principal['claims']['attrs']['clearance'] },
          },
        }),
        allow(permissions.doc.update, { where: { region: context['region'] } }),
      ]),
    ],
    subject: () => null,
  });

  it('lists the context refs a condition reads', () => {
    expect(
      contextRefs({
        op: 'and',
        conditions: [
          { op: 'eq', field: 'a', value: { ref: 'context.a' } },
          { op: 'in', field: 'b', value: [{ ref: 'context.b' }, 'x'] },
          { op: 'eq', field: 'c', value: { ref: 'principal.id' } },
        ],
      }),
    ).toEqual(['context.a', 'context.b']);
  });

  it('refuses a context grant and names the doctor check, or skips it on request', () => {
    expect(() => compileGrants(policy, base, undefined, [], false)).toThrow(
      /context\.region.*PD027/u,
    );
    const warnings: string[] = [];
    const { branches } = compileGrants(policy, base, undefined, warnings, true);
    expect(branches.map((branch) => branch.permissionKey)).toEqual([
      'doc.read',
    ]);
    expect(warnings).toContain(
      'skipped grant analyst/doc.update: it reads context.region, which is not in the token',
    );
    expect(branches[0]?.using).toContain(
      `"clearance" <= (case when jsonb_typeof(((select auth.jwt()) -> 'attrs' -> 'clearance')) = 'number' then ((select auth.jwt()) -> 'attrs' ->> 'clearance')::numeric end)`,
    );
  });
});

describe('contains on an array column', () => {
  const arrays: RlsSqlContext = {
    ...base,
    arrayColumns: { tags: 'text', reviewers: 'uuid' },
  };

  it('compiles to v = any(col) instead of like', () => {
    expect(
      compileConditionSql(
        { op: 'contains', field: 'tags', value: 'urgent' },
        arrays,
      ),
    ).toBe(`'urgent' = any("tags")`);
    expect(
      compileConditionSql(
        { op: 'contains', field: 'reviewers', value: { ref: 'principal.id' } },
        arrays,
      ),
    ).toBe(`(select auth.uid()) = any("reviewers")`);
    expect(
      compileConditionSql(
        {
          op: 'contains',
          field: 'reviewers',
          value: { ref: 'principal.claims.delegate' },
        },
        arrays,
      ),
    ).toBe(`(((select auth.jwt()) ->> 'delegate')::uuid) = any("reviewers")`);
    expect(
      compileConditionSql(
        { op: 'contains', field: 'title', value: 'draft' },
        arrays,
      ),
    ).toBe(
      `"title"::text like '%' || replace(replace(replace('draft'::text, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%' escape '\\'`,
    );
  });

  it('reads array columns and their item types from the JSON Schema', () => {
    expect(
      arrayColumnsOf({
        properties: {
          tags: { type: 'array', items: { type: 'string' } },
          reviewers: {
            type: ['array', 'null'],
            items: { type: 'string', format: 'uuid' },
          },
          title: { type: 'string' },
        },
      }),
    ).toEqual({ tags: 'text', reviewers: 'uuid' });
    expect(arrayColumnsOf(undefined)).toEqual({});
  });
});
