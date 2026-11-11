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
    it("reads the members and global-role holders and their grant keys in one query", async () => {
      const sql = await generate({ authorize: "database", memberships });
      const fn = sql.slice(
        sql.indexOf(
          'create or replace function "permdock".permitted_organization_users(p_permission text, p_id uuid)',
        ),
      );
      const body = fn.slice(0, fn.indexOf("$$;"));
      expect(body).toContain(`    select m."user_id"::uuid
      from "public"."organization_members" m
      where m."organization_id" = p_id
      union
      select ur.user_id::uuid
      from "permdock".user_roles ur`);
      expect(body).toContain('where m."user_id" = pdk_u.user_id');
      expect(body).toContain("where pdk_i.id = p_id");
      expect(body).not.toMatch(
        /_by_permission_for|permdock_has_permission_for/u,
      );
      expect(fn).toContain(
        'revoke execute on function "permdock".permitted_organization_users(text, uuid) from public, anon, authenticated;',
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
