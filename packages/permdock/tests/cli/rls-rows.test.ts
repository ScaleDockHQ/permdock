import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";

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
      `when 'doc.read' then "orgId" in (select "permdock".permitted_tenant_ids_by_permission(p_permission, true)) and coalesce(("orgId" in (select "permdock".permitted_tenant_ids('doc.read#1'))), false) and (("orgId" in (select "permdock".permitted_tenant_ids('doc.read#2'))) and ("locked" = true)) is not true`,
    );
    expect(sql).toContain(
      `when 'doc.archive' then coalesce(("ownerId" = (select "permdock".permdock_user_id())), false)`,
    );
    expect(sql).toContain(`when 'doc.update' then`);
    expect(sql).toContain(
      `when 'doc.create' then "orgId" in (select "permdock".permitted_tenant_ids_by_permission(p_permission, true)) and coalesce(("orgId" in (select "permdock".permitted_tenant_ids('doc.create'))), false)`,
    );
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
      /permitted_note_rows\(p_permission text\)[^$]*\$\$\n {2}select "id"::uuid from "public"."note"\n {2}where false\n\$\$/u,
    );
    expect(warnings.join("\n")).not.toContain("doc.archive");
  });

  it("writes a row-valued form that reads the row's columns instead of looking up its id", () => {
    const { sql } = generate("neon", ["doc"]);
    expect(sql).toContain(
      'create or replace function "permdock".permitted_doc_row(p_row "app"."documents", p_permission text)\nreturns boolean',
    );
    expect(sql).toContain(
      `with permdock_candidates as (select (p_row).*)\n  select exists (select 1 from permdock_candidates where case p_permission\n    when 'doc.archive' then`,
    );
    expect(sql).toContain(
      'grant execute on function "permdock".permitted_doc_row("app"."documents", text) to authenticated;',
    );
  });

  it("writes a form narrowed to candidate ids that reads them through the id column", () => {
    const { sql } = generate("supabase", ["doc"]);
    expect(sql).toContain(
      'create or replace function "permdock".permitted_doc_rows(p_permission text, p_ids uuid[])\nreturns setof uuid\nlanguage plpgsql',
    );
    expect(sql).toContain('v_row "app"."documents";');
    expect(sql).toContain(`foreach v_id in array coalesce(p_ids, '{}') loop`);
    expect(sql).toContain("exception when data_exception then");
    expect(sql).toContain(
      'select * from "app"."documents" where "id" = any (array(select (r)."id" from pg_catalog.unnest(v_rows) r))',
    );
    expect(sql).toContain(
      `select "id"::uuid from permdock_candidates\n  where case p_permission\n    when 'doc.archive' then`,
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
      'create or replace function "permdock".permitted_doc_row(p_id uuid, p_permission text)',
    );
    expect(sql).toContain('select * from "app"."documents" where "id" = p_id');
    expect(sql).toContain(
      'grant execute on function "permdock".permitted_doc_row(uuid, text) to authenticated;',
    );
  });

  it("leads a root-scope key with the tenant prefilter and skips it for a global role", () => {
    const { sql } = generate("supabase", ["doc"]);
    expect(sql).toContain(
      `when 'doc.read' then "orgId" in (select "permdock".permitted_tenant_ids_by_permission(p_permission, true)) and `,
    );
    expect(sql).not.toContain(
      `when 'note.read' then "orgId" in (select "permdock".permitted_tenant_ids_by_permission`,
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

describe("permitted_<resource>_row memo", () => {
  const memoized = (): string =>
    generate("supabase", ["doc"], undefined, { authorize: "database" }).sql;

  function rowBody(sql: string): string {
    const start = sql.indexOf('"permdock".permitted_doc_row(p_row');
    return sql.slice(start, sql.indexOf("$$;", start));
  }

  it("calls better_supabase.memo_get and memo_set under rls.memo 'better-supabase'", () => {
    const shared = rowBody(
      generate("supabase", ["doc"], undefined, {
        authorize: "database",
        memo: "better-supabase",
      }).sql,
    );
    expect(shared).toContain(
      "v_permdock_memo jsonb := better_supabase.memo_get(v_permdock_key)::jsonb;",
    );
    expect(shared).not.toContain("memo_set(");
    expect(shared).not.toContain("set_config(");
    expect(rowBody(memoized())).not.toContain("set_config(");
  });

  it("keeps the sql form when the helpers do not memoize", () => {
    expect(rowBody(generate("supabase", ["doc"]).sql)).toContain(
      "returns boolean\nlanguage sql\nstable",
    );
    expect(rowBody(generate("guc", ["doc"]).sql)).not.toContain("permdock.m.");
  });

  it("reads the row-independent helper calls from one memo per statement", () => {
    const body = rowBody(memoized());
    expect(body).toContain(
      "returns boolean\nlanguage plpgsql\nstable\nsecurity definer\ncost 1000\nset search_path = ''",
    );
    expect(body).toContain(
      "v_permdock_key text := 'permdock.m.' || 'doc' || '.r' || (hashtext(p_permission) & 1023)::text;",
    );
    expect(body).toContain(
      '(select "permdock".permdock_user_id())::text,\n      p_permission,',
    );
    expect(body).not.toContain("statement_timestamp()");
    expect(body).toContain(
      "coalesce(nullif(current_setting('permdock.m.gen', true), ''), '0')",
    );
    expect(body).toContain(
      `when 'doc.read' then jsonb_build_object('t2', to_jsonb(array(select "permdock".permitted_tenant_ids('doc.read#1'))), 't3', to_jsonb(array(select "permdock".permitted_tenant_ids('doc.read#2'))))`,
    );
    expect(body).toContain(
      `when 'doc.archive' then jsonb_build_object('t0', to_jsonb((select "permdock".permdock_user_id())))`,
    );
    expect(body).toContain(
      `when 'doc.read' then coalesce(("orgId" in (select pdm.v::uuid from pg_catalog.jsonb_array_elements_text(v_permdock_terms -> 't2') pdm(v))), false) and (("orgId" in (select pdm.v::uuid from pg_catalog.jsonb_array_elements_text(v_permdock_terms -> 't3') pdm(v))) and ("locked" = true)) is not true`,
    );
    expect(body).toContain(
      `when 'doc.archive' then coalesce(("ownerId" = ((v_permdock_terms ->> 't0')::uuid)), false)`,
    );
    expect(body).not.toContain("set_config(");
    expect(body).toContain(
      "return exists (\n    with permdock_candidates as (select (p_row).*)",
    );
    expect(memoized()).toContain(
      'grant execute on function "permdock".permitted_doc_row("app"."documents", text) to authenticated;',
    );
  });

  it("leaves row-dependent and unknown helper calls in place", () => {
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
    const item = sql.slice(sql.indexOf('"permdock".permitted_item_row(p_row'));
    expect(item.slice(0, item.indexOf("$$;"))).toContain("language sql");
    expect(item).toContain(
      `"permdock".permitted_space_rows('space.read', array(select "spaceId"::uuid from permdock_candidates))`,
    );
    const space = sql.slice(
      sql.indexOf('"permdock".permitted_space_row(p_row'),
    );
    expect(space.slice(0, space.indexOf("$$;"))).toContain("language plpgsql");
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
        rowHelper: "permitted_job_row",
      },
      {
        key: "job.read@all",
        permission: "job.read",
        conditioned: false,
        rowHelper: "permitted_job_row",
      },
    ]);
  });
});
