import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";

import { memoizedSetofSql } from "../../src/cli/rls/helper-bodies.ts";
import {
  levelKeys,
  rowHelpersSql,
  rowsHelper,
} from "../../src/cli/rls/rows.ts";
import { compileGrants } from "../../src/cli/sql/compile.ts";
import { scopeList } from "../../src/core/scopes.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  inherit,
  principal,
  relation,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  doc: resource({
    actions: ["read", "update", "archive"],
    collection: ["create"],
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      owner: "ownerId",
    },
  }),
  note: resource({ actions: ["read"] }),
});

const { doc } = permissions;

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("member", [allow([doc.read, doc.create])], { on: "tenant" }),
    role("blocked", [deny(doc.read, { where: { locked: true } })], {
      on: "tenant",
    }),
    role("noter", [deny(permissions.note.read)]),
  ],
  grants: [allow([doc.update, doc.archive], { to: relation(doc, "owner") })],
  subject: () => null,
});

function context(
  dialect: RlsSqlContext["dialect"],
  idTypes?: Readonly<Record<string, string>>,
): RlsSqlContext {
  return {
    dialect,
    ...(idTypes === undefined ? {} : { idTypes }),
    scopes: scopeList(policy.scopes),
    tenantClaim: "tenant_id",
    gucPrefix: "app",
    actions: { archive: "none" },
  };
}

function generate(
  dialect: RlsSqlContext["dialect"],
  select: true | readonly string[] = true,
  idTypes?: Readonly<Record<string, string>>,
  extra: Partial<RlsSqlContext> = {},
): { readonly sql: string; readonly warnings: readonly string[] } {
  const warnings: string[] = [];
  const ctx = { ...context(dialect, idTypes), ...extra };
  const compiled = compileGrants(policy, ctx, undefined, warnings, false, true);
  const sql = rowHelpersSql(
    ctx,
    policy,
    [...compiled.branches, ...compiled.actionBranches],
    select,
    { doc: "app.documents" },
    warnings,
  );
  return { sql, warnings };
}

describe("permitted_<resource>_rows", () => {
  it("writes nothing for an empty resource list", () => {
    expect(generate("supabase", []).sql).toBe("");
  });

  it("cases each permission over its allows and denies, actions without a SQL command included", () => {
    const { sql, warnings } = generate("supabase", ["doc", "note"]);
    expect(generate("supabase").sql).toContain("permitted_note_rows");
    expect(sql).toContain('"permdock".permitted_doc_rows(p_permission text)');
    expect(sql).toContain('select "id"::uuid from "app"."documents"');
    expect(sql).toContain(
      '"permdock".permitted_doc_match(permdock_row, p_permission)',
    );
    expect(sql).toContain(
      `when 'doc.read' then coalesce(("orgId" = any(array(select "permdock".permitted_tenant_ids('doc.read#1')))), false) and (("orgId" = any(array(select "permdock".permitted_tenant_ids('doc.read#2')))) and ("locked" = true)) is not true`,
    );
    expect(sql).toContain(
      `when 'doc.archive' then coalesce(("ownerId" = (select "permdock".permdock_user_id())), false)`,
    );
    expect(sql).toContain(`when 'doc.update' then`);
    const create = `when 'doc.create' then coalesce(("orgId" = any(array(select "permdock".permitted_tenant_ids('doc.create')))), false)`;
    // The match and the id-set query each carry an arm that reads only the row.
    expect(sql.split(create)).toHaveLength(3);
    expect(sql).toContain("    else false");
    expect(sql).toContain(
      '"permdock".permitted_doc_rows_for(p_user uuid, p_permission text, p_claims jsonb',
    );
    expect(sql).toContain(
      'revoke execute on function "permdock".permitted_doc_rows_for(uuid, text, jsonb) from public, anon, authenticated;',
    );
    expect(sql).toContain(
      `"permdock".permitted_doc_rows_for(p_user uuid, p_permission text, p_ids uuid[], p_claims jsonb default '{}')`,
    );
    expect(sql).toContain(
      'return query select r.id from "permdock".permitted_doc_rows(p_permission, p_ids) r(id);',
    );
    expect(sql).toContain(
      'revoke execute on function "permdock".permitted_doc_rows_for(uuid, text, uuid[], jsonb) from public, anon, authenticated;',
    );
    expect(sql).not.toMatch(
      /grant execute on function "permdock"\.permitted_doc_rows_for/u,
    );
    expect(sql).toContain('"permdock".permitted_note_rows');
    expect(sql).not.toContain(`when 'note.read'`);
    expect(sql).toMatch(
      /permitted_note_rows\(p_permission text\)[^$]*\$\$\n {2}select "id"::uuid from "public"."note" as permdock_row\n {2}where "permdock"\.permitted_note_match\(permdock_row, p_permission\)\n\$\$/u,
    );
    expect(warnings.join("\n")).not.toContain("doc.archive");
  });

  it("writes a row-valued form that reads the row's columns instead of looking up its id", () => {
    const { sql } = generate("neon", ["doc"]);
    expect(sql).toContain(
      'create or replace function "permdock".can_doc(p_row "app"."documents", p_permission text)\nreturns boolean',
    );
    expect(sql).toContain(
      'select "permdock".permitted_doc_match(p_row, p_permission)',
    );
    expect(sql).toContain(
      `with permdock_candidates as (select (p_row).*)\n  select exists (select 1 from permdock_candidates where case p_permission\n    when 'doc.archive' then`,
    );
    expect(sql).toContain(
      'grant execute on function "permdock".can_doc("app"."documents", text) to authenticated;',
    );
  });

  it("writes a form narrowed to candidate ids that reads them through the id column", () => {
    const { sql } = generate("supabase", ["doc"]);
    expect(sql).toContain(
      'create or replace function "permdock".permitted_doc_rows(p_permission text, p_ids uuid[])\nreturns setof uuid\nlanguage plpgsql',
    );
    expect(sql).toContain('v_row "app"."documents";');
    expect(sql).toContain(
      `foreach v_id in array coalesce(p_ids, '{}'::uuid[]) loop`,
    );
    expect(sql).toContain("exception when data_exception then");
    expect(sql).toContain(
      'select * from "app"."documents" where "id" = any (array(select (r)."id" from pg_catalog.unnest(v_rows) r))',
    );
    expect(sql).toContain(
      'select "id"::uuid from permdock_candidates\n  where "permdock".permitted_doc_match(permdock_candidates, p_permission);',
    );
    expect(sql).toContain(
      'grant execute on function "permdock".permitted_doc_rows(text, uuid[]) to authenticated;',
    );
  });

  it("types the ids from rls.idTypes, a named resource over the * default", () => {
    const text = generate("supabase", ["doc"], { "*": "text" }).sql;
    expect(text).toContain("p_ids text[]");
    expect(text).not.toContain("uuid[]");
    const bigint = generate("supabase", ["doc"], {
      "*": "text",
      doc: "bigint",
    }).sql;
    expect(bigint).toContain(
      "p_permission text, p_ids bigint[])\nreturns setof bigint",
    );
    expect(bigint).toContain('select "id"::bigint from permdock_candidates');
  });

  it("writes a scalar _row overload that reads one row by id", () => {
    const { sql } = generate("supabase", ["doc"]);
    expect(sql).toContain(
      'create or replace function "permdock".can_doc(p_id uuid, p_permission text)',
    );
    expect(sql).toContain(
      'select 1 from "app"."documents" as permdock_row\n    where permdock_row."id" = p_id\n      and "permdock".permitted_doc_match(permdock_row, p_permission)',
    );
    expect(sql).toContain(
      'grant execute on function "permdock".can_doc(uuid, text) to authenticated;',
    );
  });

  it("carries an arm that reads only the row in the id-set query, and calls the match for the rest", () => {
    const { sql } = generate("supabase", ["doc"]);
    const rows = sql.slice(
      sql.indexOf(
        'create or replace function "permdock".permitted_doc_rows(p_permission text)',
      ),
    );
    const body = rows.slice(0, rows.indexOf("$$;", rows.indexOf("as $$")));
    expect(body).toContain(
      `when 'doc.read' then coalesce(("orgId" = any(array(select "permdock".permitted_tenant_ids('doc.read#1')))), false)`,
    );
    expect(body).toContain(
      'else "permdock".permitted_doc_match(permdock_row, p_permission)',
    );
    expect(sql).not.toContain(
      "permitted_tenant_ids_by_permission(p_permission, true))\n",
    );
  });

  it("leaves a key to the match when the policy declares no scope", () => {
    const { sql } = generate("supabase", ["note"], undefined, { scopes: [] });
    const body = sql.slice(
      sql.indexOf(
        'create or replace function "permdock".permitted_note_rows(p_permission text)',
      ),
    );
    expect(body).toContain("permitted_note_match(permdock_row, p_permission)");
    expect(body).not.toContain("by_permission");
  });

  it("leads a root-scope key with the tenant prefilter when the match cannot be carried inline", () => {
    const warnings: string[] = [];
    const ctx = context("supabase");
    const compiled = compileGrants(
      policy,
      ctx,
      undefined,
      warnings,
      false,
      true,
    );
    // The match decides nothing for the narrowed set, so no arm is carried inline.
    const sql = rowHelpersSql(
      ctx,
      policy,
      [...compiled.branches, ...compiled.actionBranches],
      ["doc"],
      { doc: "app.documents" },
      warnings,
      [],
    );
    expect(sql).toContain(
      `when 'doc.read' then "orgId" = any(array(select "permdock".permitted_tenant_ids_by_permission(p_permission, true))) and "permdock".permitted_doc_match(permdock_row, p_permission)`,
    );
  });

  it("sets the guc user and claims for a named user and restores them", () => {
    const { sql } = generate("guc", ["doc"]);
    expect(sql).toContain("p_user text, p_permission text, p_claims jsonb");
    expect(sql).toContain(
      "pg_catalog.set_config('app.' || v_key, v_value, true)",
    );
    expect(sql).not.toContain("permitted_note_rows");
  });

  it("writes no _for form for neon and says why", () => {
    const { sql, warnings } = generate("neon", ["doc"]);
    expect(sql).not.toContain("permitted_doc_rows_for");
    expect(warnings.at(-1)).toMatch(/neon dialect reads the subject/u);
  });

  it("refuses an undeclared resource and a name SQL cannot hold", () => {
    expect(() => generate("supabase", ["ghost"])).toThrow(
      "rls.rowHelpers names 'ghost', which the policy does not declare",
    );
    expect(() => rowsHelper("odd-name")).toThrow(/cannot name a helper/u);
    expect(() => rowsHelper(`r${"x".repeat(50)}`)).toThrow(/at most 45 bytes/u);
    expect(rowsHelper("chatThread")).toBe("permitted_chat_thread_rows");
  });
});

describe("permitted_<resource>_match", () => {
  function matchBody(sql: string): string {
    const start = sql.indexOf('"permdock".permitted_doc_match(p_row');
    return sql.slice(start, sql.indexOf("$$;", start));
  }

  it("is one stable predicate the row forms call, with no term map", () => {
    const sql = generate("supabase", ["doc"], undefined, {
      authorize: "database",
    }).sql;
    const body = matchBody(sql);
    expect(body).toContain("returns boolean\nlanguage sql\nstable");
    expect(body).toContain(
      `when 'doc.read' then coalesce(("orgId" = any(array(select "permdock".permitted_tenant_ids('doc.read#1')))), false)`,
    );
    expect(body).toContain(
      `when 'doc.archive' then coalesce(("ownerId" = (select "permdock".permdock_user_id())), false)`,
    );
    expect(sql).not.toContain("v_permdock_terms");
    expect(sql).not.toContain("jsonb_build_object('t");
    expect(sql).toContain(
      'select "permdock".permitted_doc_match(p_row, p_permission)',
    );
    expect(sql).toContain(
      '"permdock".permitted_doc_match(permdock_row, p_permission)',
    );
    expect(sql).toContain(
      '"permdock".permitted_doc_match(permdock_candidates, p_permission)',
    );
  });

  it("keeps a row-dependent inherit call inside the match", () => {
    const linked = definePermissions({
      space: resource({
        actions: ["read"],
        relations: { org: { field: "orgId", memberOf: "tenant" } },
      }),
      item: resource({
        actions: ["read"],
        links: { space: { field: "spaceId", resource: "space" } },
      }),
    });
    const linkedPolicy = definePolicy(linked, {
      scopes: { tenant: { key: "orgId" } },
      roles: [role("member", [allow(linked.space.read)], { on: "tenant" })],
      grants: [
        allow(linked.item.read, {
          to: inherit(linked.space.read, { through: ["space"] }),
        }),
      ],
      subject: () => null,
    });
    const ctx: RlsSqlContext = {
      ...context("supabase"),
      authorize: "database",
      graph: { closures: {}, resources: linkedPolicy.resources },
    };
    const compiled = compileGrants(
      linkedPolicy,
      { ...ctx, candidates: "permdock_candidates" },
      undefined,
      [],
      false,
      true,
    );
    const sql = rowHelpersSql(
      ctx,
      linkedPolicy,
      [...compiled.branches, ...compiled.actionBranches],
      ["item", "space"],
      undefined,
      [],
    );
    const item = sql.slice(
      sql.indexOf('"permdock".permitted_item_match(p_row'),
    );
    expect(item.slice(0, item.indexOf("$$;"))).toContain("language sql");
    expect(item.slice(0, item.indexOf("$$;"))).toContain(
      `"permdock".permitted_space_rows('space.read', array(select "spaceId"::uuid from permdock_candidates))`,
    );
    expect(sql).toContain(
      'select "permdock".permitted_item_match(p_row, p_permission)',
    );
  });

  it("keeps a shared relation on every permission it grants", () => {
    const shared = definePermissions({
      space: resource({
        actions: ["read"],
        relations: { org: { field: "orgId", memberOf: "tenant" } },
      }),
      item: resource({
        actions: ["read", "review"],
        links: { space: { field: "spaceId", resource: "space" } },
      }),
    });
    const sharedPolicy = definePolicy(shared, {
      scopes: { tenant: { key: "orgId" } },
      roles: [role("member", [allow(shared.space.read)], { on: "tenant" })],
      grants: [
        allow([shared.item.read, shared.item.review], {
          to: inherit(shared.space.read, { through: ["space"] }),
        }),
      ],
      subject: () => null,
    });
    const ctx: RlsSqlContext = {
      ...context("supabase"),
      authorize: "database",
      actions: { review: "none" },
      graph: { closures: {}, resources: sharedPolicy.resources },
    };
    const compiled = compileGrants(
      sharedPolicy,
      { ...ctx, candidates: "permdock_candidates" },
      undefined,
      [],
      false,
      true,
    );
    const sql = rowHelpersSql(
      ctx,
      sharedPolicy,
      [...compiled.branches, ...compiled.actionBranches],
      ["item"],
      undefined,
      [],
    );
    const read = sql.slice(
      sql.indexOf("when 'item.read'"),
      sql.indexOf("when 'item.review'"),
    );
    const review = sql.slice(sql.indexOf("when 'item.review'"));
    expect(read).toContain("permitted_space_rows('space.read'");
    expect(review).toContain("permitted_space_rows('space.read'");
  });

  it("reads a stored relation list and calls the helper only on a miss", () => {
    const shared = definePermissions({
      doc: resource({
        actions: ["read"],
        relations: {
          org: { field: "orgId", memberOf: "tenant" },
          viewer: { edge: "doc_shares", object: "doc_id", subject: "user_id" },
        },
      }),
    });
    const sharedPolicy = definePolicy(shared, {
      scopes: { tenant: { key: "orgId" } },
      roles: [role("member", [allow(shared.doc.read)], { on: "tenant" })],
      grants: [allow(shared.doc.read, { to: relation(shared.doc, "viewer") })],
      subject: () => null,
    });
    const base = { ...context("supabase"), authorize: "database" as const };
    const touches: NonNullable<RlsSqlContext["memoTouches"]> = [];
    const ctx: RlsSqlContext = {
      ...base,
      reuseMemo: true,
      memoTouches: touches,
    };
    const compiled = compileGrants(
      sharedPolicy,
      { ...ctx, candidates: "permdock_candidates" },
      undefined,
      [],
      false,
      true,
    );
    const first = touches[0];
    if (first !== undefined) {
      touches.push(first);
    }
    const branches = [
      ...compiled.branches,
      ...compiled.actionBranches,
    ] as const;
    const sql = rowHelpersSql(
      ctx,
      sharedPolicy,
      branches,
      ["doc"],
      undefined,
      [],
    );
    expect(sql).toContain("select count(*) from");
    expect(sql).toContain("'rel.doc'");
    expect(sql).toContain("permitted_doc_ids('viewer')");
    expect(sql).not.toContain("v_permdock_terms");
    const plain = rowHelpersSql(
      base,
      sharedPolicy,
      branches,
      ["doc"],
      undefined,
      [],
    );
    expect(plain).not.toContain("select count(*) from");
    const gateway: RlsSqlContext = {
      ...ctx,
      memo: "better-supabase",
      memoTouches: [],
    };
    const again = compileGrants(
      sharedPolicy,
      { ...gateway, candidates: "permdock_candidates" },
      undefined,
      [],
      false,
      true,
    );
    const better = rowHelpersSql(
      gateway,
      sharedPolicy,
      [...again.branches, ...again.actionBranches],
      ["doc"],
      undefined,
      [],
    );
    expect(better).toContain("better_supabase.memo_get");
    const stored = memoizedSetofSql({
      fn: '"permdock".permitted_doc_ids',
      param: "p_relation text",
      returns: "setof text",
      idType: "text",
      scope: "rel.doc",
      keySql: "coalesce(p_relation, '')",
      userSql: '(select "permdock".permdock_user_id())',
      query: "  select null::text where false",
      grants:
        'revoke execute on function "permdock".permitted_doc_ids(text) from public;',
    });
    expect(stored).toContain("set_config(");
    const hosted = memoizedSetofSql({
      fn: '"permdock".permitted_doc_ids',
      param: "p_relation text",
      returns: "setof text",
      idType: "text",
      scope: "rel.doc",
      keySql: "coalesce(p_relation, '')",
      userSql: '(select "permdock".permdock_user_id())',
      query: "  select null::text where false",
      api: "better-supabase",
      grants:
        'revoke execute on function "permdock".permitted_doc_ids(text) from public;',
    });
    expect(hosted).toContain("better_supabase.memo_set");
  });
});

describe(levelKeys, () => {
  it("lists each level of an instance permission and whether it has a condition", () => {
    const levelled = definePermissions({
      job: resource({
        actions: ["read"],
        collection: ["create"],
        levels: { own: { ownerId: principal.id }, all: {} },
      }),
    });
    const jobs = definePolicy(levelled, {
      subject: () => null,
      roles: [role("owner", [allow(levelled.job.read)])],
    });
    expect(levelKeys(jobs)).toStrictEqual([
      {
        key: "job.read@own",
        permission: "job.read",
        conditioned: true,
        rowHelper: "can_job",
      },
      {
        key: "job.read@all",
        permission: "job.read",
        conditioned: false,
        rowHelper: "can_job",
      },
    ]);
  });
});
