import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { CompiledPolicy } from "../../src/cli/sql/compile.ts";

import { run } from "../../src/cli/core/run.ts";
import {
  readOnlyActorKinds,
  readOnlyActorPolicies,
} from "../../src/cli/rls/policies.ts";
import { project, removeProjects } from "./doctor-kit.ts";

describe("rls read only actors", () => {
  afterAll(removeProjects);

  const ACT = "((select auth.jwt()) -> 'act')";
  const GUARD = '(select "permdock".permdock_actor_may_write())';
  const READ_ONLY_AGENT = ` and not coalesce((${ACT} ->> 'kind') = 'agent' and (${ACT} ->> 'read_only') = 'true', false)`;

  const allow = (
    table: string,
    command: CompiledPolicy["command"],
    roles: readonly string[] = ["authenticated"],
  ): CompiledPolicy => ({
    name: `${table}_${command}`,
    table,
    command,
    effect: "allow",
    roles,
    using: "true",
  });

  describe("rls.readOnlyActors", () => {
    it("adds one restrictive policy per table and write command granted to authenticated", () => {
      const policies = readOnlyActorPolicies(
        [
          allow("quotes", "select"),
          allow("quotes", "insert"),
          allow("quotes", "update"),
          allow("quotes", "delete"),
          allow("public_notes", "update", ["anon"]),
          { ...allow("quotes", "update"), effect: "deny" },
        ],
        GUARD,
      );
      const passes = GUARD;
      expect(policies).toStrictEqual([
        {
          name: "quotes_insert_read_only_actors",
          table: "quotes",
          command: "insert",
          effect: "deny",
          roles: ["authenticated"],
          check: passes,
        },
        {
          name: "quotes_update_read_only_actors",
          table: "quotes",
          command: "update",
          effect: "deny",
          roles: ["authenticated"],
          using: passes,
          check: passes,
        },
        {
          name: "quotes_delete_read_only_actors",
          table: "quotes",
          command: "delete",
          effect: "deny",
          roles: ["authenticated"],
          using: passes,
        },
      ]);
    });

    it("checks the guard function once per statement and nothing else", () => {
      const [policy] = readOnlyActorPolicies(
        [allow("quotes", "delete")],
        GUARD,
      );
      expect(policy?.using).toBe(GUARD);
      expect(GUARD).toContain("permdock_actor_may_write()");
    });

    it("defines the function before the policies that call it, with the kinds inside it", async () => {
      const policyPath = path.join(
        import.meta.dirname,
        "../fixtures/named-scopes.ts",
      );
      const cwd = project({
        "permdock.config.ts": `export default ${JSON.stringify({
          permissions: policyPath,
          policy: policyPath,
          rls: { dialect: "supabase", readOnlyActors: ["impersonation"] },
        })};\n`,
      });
      const result = await run(["rls", "generate", "--out", "rls.sql"], {
        cwd,
      });
      expect(result.code).toBe(0);
      const sql = readFileSync(path.join(cwd, "rls.sql"), "utf8");
      const defined = sql.indexOf(
        'create or replace function "permdock".permdock_actor_may_write()',
      );
      const used = sql.indexOf('create policy "public_');
      const guard = sql.search(/create policy "[a-z_]+_read_only_actors"/u);
      expect(defined).toBeGreaterThan(-1);
      expect(guard).toBeGreaterThan(defined);
      expect(used === -1 || guard > defined).toBe(true);
      expect(sql).toContain(`array['impersonation']::text[]`);
      expect(sql).toContain(READ_ONLY_AGENT);
      expect(sql).toMatch(
        /using \(\(select "permdock"\.permdock_actor_may_write\(\)\)\)/u,
      );
      expect(sql).not.toMatch(
        /create policy "[a-z_]+_read_only_actors"[\s\S]*?'read_only'/u,
      );
    });

    it("reads true as support and impersonation and refuses an empty or unsafe list", () => {
      expect(readOnlyActorKinds(undefined)).toBeUndefined();
      expect(readOnlyActorKinds(false)).toBeUndefined();
      expect(readOnlyActorKinds(true)).toStrictEqual([
        "support",
        "impersonation",
      ]);
      expect(readOnlyActorKinds(["support", "support"])).toStrictEqual([
        "support",
      ]);
      expect(() => readOnlyActorKinds([])).toThrow(/non-empty list/u);
      expect(() => readOnlyActorKinds(["x'; drop"])).toThrow(/actor kinds/u);
    });

    it("writes the policies from rls generate, and the function with --helpers-only", async () => {
      const policyPath = path.join(
        import.meta.dirname,
        "../fixtures/named-scopes.ts",
      );
      const config = (rls: Record<string, unknown>): string =>
        `export default ${JSON.stringify({
          permissions: policyPath,
          policy: policyPath,
          rls: { dialect: "supabase", ...rls },
        })};\n`;
      const cwd = project({
        "permdock.config.ts": config({ readOnlyActors: true }),
      });
      const result = await run(["rls", "generate", "--out", "rls.sql"], {
        cwd,
      });
      expect(result.code).toBe(0);
      const sql = readFileSync(path.join(cwd, "rls.sql"), "utf8");
      expect(sql).toMatch(
        /create policy "[a-z_]+_update_read_only_actors"\n {2}on "public"\."[a-z_]+"\n {2}as restrictive\n {2}for update\n {2}to authenticated/u,
      );
      expect(sql).not.toContain("_select_read_only_actors");

      const helpers = project({
        "permdock.config.ts": config({
          readOnlyActors: ["support"],
          helpersOnly: true,
        }),
      });
      const quiet = await run(["rls", "generate", "--out", "rls.sql"], {
        cwd: helpers,
      });
      expect(quiet.stdout + quiet.stderr).toContain(
        'rls.readOnlyActors with --helpers-only writes read-only actor policies only on tables rls.tables names; for public.asset, public.quote, name the table in rls.tables, or add `and (select "permdock".permdock_actor_may_write())` to each hand-written insert, update and delete policy',
      );
      const helperSql = readFileSync(path.join(helpers, "rls.sql"), "utf8");
      expect(helperSql).not.toContain("_read_only_actors");
      expect(helperSql).toContain(
        `create or replace function "permdock".permdock_actor_may_write()
returns boolean
language sql
stable
set search_path = ''
as $$
  select (not coalesce((${ACT} ->> 'kind') = any(array['support']::text[]) or ((${ACT} ->> 'kind') is null and ${ACT} ? 'session_id'), false) or coalesce((${ACT} ->> 'read_only') = 'false', false))${READ_ONLY_AGENT}
$$;
revoke execute on function "permdock".permdock_actor_may_write() from public, anon;
grant execute on function "permdock".permdock_actor_may_write() to authenticated;`,
      );
      expect(sql).toContain('"permdock".permdock_actor_may_write()');
    });

    it("writes guarded read-only actor policies with --helpers-only on the tables rls.tables names", async () => {
      const policyPath = path.join(
        import.meta.dirname,
        "../fixtures/named-scopes.ts",
      );
      const cwd = project({
        "permdock.config.ts": `export default ${JSON.stringify({
          permissions: policyPath,
          policy: policyPath,
          rls: {
            dialect: "supabase",
            readOnlyActors: true,
            helpersOnly: true,
            tables: { quote: "public.quotes", invoice: "invoices" },
          },
        })};\n`,
      });
      const result = await run(["rls", "generate", "--out", "rls.sql"], {
        cwd,
      });
      expect(result.code).toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain("for public.asset, name the table");
      expect(output).not.toContain("public.quotes, name");
      const sql = readFileSync(path.join(cwd, "rls.sql"), "utf8");
      expect(sql).toContain(
        `drop policy if exists "public_quotes_update_read_only_actors" on "public"."quotes";
create policy "public_quotes_update_read_only_actors"
  on "public"."quotes"
  as restrictive
  for update
  to authenticated`,
      );
      expect(sql).not.toContain("to_regclass('public.quotes')");
      expect(sql).toContain('"public_quotes_delete_read_only_actors"');
      expect(sql).not.toMatch(/on "public"\."(asset|invoices)"/u);
      expect(sql).not.toMatch(/as permissive/u);
      expect(sql).not.toContain("_select_read_only_actors");
      expect(sql).not.toMatch(/"public"\.\S+ enable row level security/u);
      expect(sql).not.toMatch(/^grant .* on table "public"\."quotes"/mu);

      const split = await run(
        [
          "rls",
          "generate",
          "--split",
          "helpers",
          "--no-seeds",
          "--out",
          "rls_{part}.sql",
        ],
        { cwd },
      );
      expect(split.code).toBe(0);
      const helpers = readFileSync(path.join(cwd, "rls_helpers.sql"), "utf8");
      expect(helpers).toContain('"public_quotes_update_read_only_actors"');
      expect(helpers).toContain("permdock_actor_may_write()");
    });
  });
});
