import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { run } from "../../src/cli/run.ts";
import { project, removeProjects } from "./doctor-kit.ts";

afterAll(removeProjects);

const policyPath = path.join(
  import.meta.dirname,
  "../fixtures/named-scopes.ts",
);

async function generate(rls: Record<string, unknown>): Promise<string> {
  const cwd = project({
    "permdock.config.ts": `export default ${JSON.stringify({
      permissions: policyPath,
      policy: policyPath,
      rls: { dialect: "supabase", ...rls },
    })};\n`,
  });
  const result = await run(["rls", "generate", "--out", "rls.sql"], { cwd });
  expect(result.code).toBe(0);
  return readFileSync(path.join(cwd, "rls.sql"), "utf8");
}

const memberships = {
  tenant: {
    table: "organization_members",
    tenant: "organization_id",
    user: "user_id",
    role: "role",
  },
};

describe("permitted_<scope>_users", () => {
  it("lists the members and global-role holders the _for helpers answer for", async () => {
    const sql = await generate({
      authorize: "database",
      memberships,
    });
    expect(sql).toContain(
      `create or replace function "permdock".permitted_organization_users(p_permission text, p_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.user_id
  from (
    select m."user_id"::uuid
    from "public"."organization_members" m
    where m."organization_id" = p_id
    union
    select ur.user_id::uuid
    from "permdock".user_roles ur
  ) c(user_id)
  where c.user_id is not null
    and (
      p_id in (select "permdock".permitted_organization_ids_by_permission_for(c.user_id, p_permission))
      or "permdock".permdock_has_permission_for(c.user_id, p_permission)
    )
  order by 1
$$;
revoke execute on function "permdock".permitted_organization_users(text, uuid) from public, anon, authenticated;`,
    );
    expect(sql).toContain(
      "-- customer: no memberships table or table source, so permitted_customer_users is not written",
    );
  });

  it("is not written when memberships come from the token", async () => {
    const sql = await generate({ authorize: "jwt" });
    expect(sql).not.toContain("_users(");
  });
});
