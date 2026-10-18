import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { CompiledPolicy } from "../../src/cli/sql/compile.ts";

import {
  readOnlyActorKinds,
  readOnlyActorPolicies,
} from "../../src/cli/rls/policies.ts";
import { run } from "../../src/cli/run.ts";
import { project, removeProjects } from "./doctor-kit.ts";

afterAll(removeProjects);

const ACT = "((select auth.jwt()) -> 'act')";
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
      ACT,
      ["support", "impersonation"],
    );
    const passes = `(not coalesce((${ACT} ->> 'kind') = any(array['support', 'impersonation']::text[]) or ((${ACT} ->> 'kind') is null and ${ACT} ? 'session_id'), false) or coalesce((${ACT} ->> 'read_only') = 'false', false))${READ_ONLY_AGENT}`;
    expect(policies).toEqual([
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

  it("matches only the listed kinds, without the session_id fallback when support is not one", () => {
    const [policy] = readOnlyActorPolicies([allow("quotes", "delete")], ACT, [
      "impersonation",
    ]);
    expect(policy?.using).toBe(
      `(not coalesce((${ACT} ->> 'kind') = any(array['impersonation']::text[]), false) or coalesce((${ACT} ->> 'read_only') = 'false', false))${READ_ONLY_AGENT}`,
    );
  });

  it("refuses an agent only with read_only true, unless agent is a listed kind", () => {
    const [policy] = readOnlyActorPolicies([allow("quotes", "delete")], ACT, [
      "support",
    ]);
    expect(policy?.using).toContain(READ_ONLY_AGENT);
    const [listed] = readOnlyActorPolicies([allow("quotes", "delete")], ACT, [
      "agent",
    ]);
    expect(listed?.using).toBe(
      `(not coalesce((${ACT} ->> 'kind') = any(array['agent']::text[]), false) or coalesce((${ACT} ->> 'read_only') = 'false', false))`,
    );
  });

  it("reads true as support and impersonation and refuses an empty or unsafe list", () => {
    expect(readOnlyActorKinds(undefined)).toBeUndefined();
    expect(readOnlyActorKinds(false)).toBeUndefined();
    expect(readOnlyActorKinds(true)).toEqual(["support", "impersonation"]);
    expect(readOnlyActorKinds(["support", "support"])).toEqual(["support"]);
    expect(() => readOnlyActorKinds([])).toThrow(/non-empty list/u);
    expect(() => readOnlyActorKinds(["x'; drop"])).toThrow(/actor kinds/u);
  });

  it("writes the policies from rls generate, and warns with --helpers-only", async () => {
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
      'rls.readOnlyActors with --helpers-only writes no policies: add `and (select "permdock".permdock_actor_may_write())` to each hand-written insert, update and delete policy',
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
});
