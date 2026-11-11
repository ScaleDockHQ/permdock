import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { project, removeProjects } from "./doctor-kit.ts";
import { rlsGenerate } from "./rls-call.ts";

describe("rls permitted users", () => {
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
    const result = await rlsGenerate(["--out", "rls.sql"], { cwd });
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
    it("lists the holders on one instance in one set-based query over the membership table", async () => {
      const sql = await generate({ authorize: "database", memberships });
      expect(sql).toContain(
        `create or replace function "permdock".permitted_organization_users(p_permission text, p_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  with pdk_h(user_id, grant_key) as (
  select m."user_id"::uuid, rp.grant_key
  from "public"."organization_members" m
  cross join lateral "permdock".permdock_role_grant_keys('organization', m."role"::text) rp(grant_key)
  where m."organization_id" = p_id
    and not (m."role"::text = any(array['admin', 'contact', 'member', 'owner', 'viewer']::text[]))
  )
  select h.user_id from pdk_h h
  where h.user_id is not null
    and h.grant_key in (select g.grant_key from "permdock".grant_keys(p_permission, 'organization') g(grant_key))
  except
  select h.user_id from pdk_h h
  where h.grant_key in (select g.grant_key from "permdock".grant_keys(p_permission, 'organization', 'deny') g(grant_key))
  union
  select ur.user_id::uuid
  from "permdock".user_roles ur
  where ur.user_id is not null
    and "permdock".permdock_has_permission_for(ur.user_id::uuid, p_permission)
  order by 1
$$;
revoke execute on function "permdock".permitted_organization_users(text, uuid) from public, anon, authenticated;`,
      );
      expect(sql).not.toContain(
        "permitted_organization_ids_by_permission_for(c.user_id",
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
});
