import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";

import { pd005 } from "../../src/cli/doctor-project.ts";
import { compileGrants } from "../../src/cli/rls-compile.ts";
import { helpersSql } from "../../src/cli/rls-helpers.ts";
import { assignmentSql, ownershipRules } from "../../src/cli/rls-ownership.ts";
import { permissionHelpersSql } from "../../src/cli/rls-permission-keys.ts";
import { shimGrants } from "../../src/cli/rls-shims.ts";
import { isSeedsDirectory, seedsMigration } from "../../src/cli/sql-files.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { policy } from "../fixtures/named-scopes.ts";

const TMP = path.join(import.meta.dirname, "../../tmp");
mkdirSync(TMP, { recursive: true });
const cwd = mkdtempSync(path.join(TMP, "gap-branches-"));

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const scopes = scopeList(policy.scopes);
const base: RlsSqlContext = {
  dialect: "guc",
  tenantClaim: "tenant_id",
  scopes,
  gucPrefix: "app",
  authorize: "database",
};

describe("seeds directory", () => {
  it("tells a directory from a file and the stdout marker", () => {
    mkdirSync(path.join(cwd, "migrations"), { recursive: true });
    expect(isSeedsDirectory(cwd, "-")).toBe(false);
    expect(isSeedsDirectory(cwd, "migrations")).toBe(true);
    expect(isSeedsDirectory(cwd, "absent")).toBe(false);
    expect(isSeedsDirectory(cwd, "absent/")).toBe(true);
    expect(seedsMigration(cwd, "fresh", "-- m", "-- m\n", new Date(0))).toEqual(
      { rel: "fresh/19700101000000_permdock_seeds.sql", current: false },
    );
  });
});

describe("permission-key helpers outside Supabase", () => {
  it("take a text user and no rename map", () => {
    const compiled = compileGrants(policy, base, undefined, [], false);
    const sql = permissionHelpersSql(
      base,
      shimGrants(compiled.rolePermissions, compiled.conditionedKeys, {}),
      {},
      false,
    );
    expect(sql).toContain("-> p_scope -> p_permission -> p_effect");
    expect(sql).toContain("(p_user text, p_permission text)");
  });
});

describe("assignment triggers on a nested scope's table with role sources", () => {
  it("reads a list of role columns and the tenant column", () => {
    const ownership = ownershipRules(policy, scopes);
    const sql = assignmentSql({
      ...base,
      memberships: {
        scopes: {
          customer: {
            table: "customer_contacts",
            user: "user_id",
            role: [
              "tier",
              { through: "roles", on: { role_id: "id" }, column: "key" },
            ],
            columns: {
              customer: "customer_id",
              organization: "organization_id",
            },
          },
        },
      },
      assignments: { tables: [] },
      ...(ownership === undefined ? {} : { ownership }),
    });
    expect(sql).toContain(
      `array[new."tier"::text, (select newk."key"::text from "public"."roles" newk where newk."id" = new."role_id")]::text[]`,
    );
    expect(() =>
      assignmentSql({
        ...base,
        assignments: {
          tables: [{ table: "invites", scope: "region", id: "x", role: "r" }],
        },
        ...(ownership === undefined ? {} : { ownership }),
      }),
    ).toThrow("names scope 'region'");
  });
});

describe("custom role cascade with levels and no scope column", () => {
  it("reads the stored level into the entries it checks", () => {
    const ctx: RlsSqlContext = {
      ...base,
      memberships: {
        scopes: {
          organization: {
            table: "org_members",
            user: "user_id",
            role: "role",
            columns: { organization: "organization_id" },
          },
        },
      },
      customRoles: {
        declared: ["admin"],
        assignable: ["admin"],
        levels: true,
        table: { table: "roles", key: "key", tenant: "organization_id" },
      },
    };
    const compiled = compileGrants(policy, ctx, undefined, [], false);
    const sql = helpersSql(ctx, compiled.rolePermissions, { userRoles: true });
    expect(sql).toContain(
      "select array_agg(c.permission || coalesce('@' || c.level, '')) filter (where c.effect = 'allow')",
    );
    expect(sql).toContain("v_old_id text := null::text;");
  });
});

describe("PD005 without a workspace root", () => {
  it("looks only in the working directory when no ancestor marks a workspace", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "permdock-pd005-"));
    try {
      writeFileSync(path.join(outside, "package.json"), "not json");
      expect(pd005(outside).map((item) => item.message)).toEqual([
        "Agent Skills are not installed",
      ]);
      mkdirSync(path.join(outside, ".agents/skills/permdock"), {
        recursive: true,
      });
      writeFileSync(
        path.join(outside, ".agents/skills/permdock/SKILL.md"),
        "---\nname: permdock\n---\n",
      );
      writeFileSync(path.join(outside, "skills-lock.json"), "{");
      expect(pd005(outside).map((item) => item.message)).toEqual([
        "skills lock is missing",
      ]);
      writeFileSync(
        path.join(outside, "package.json"),
        JSON.stringify({ workspaces: ["packages/*"] }),
      );
      writeFileSync(path.join(outside, "skills-lock.json"), "null");
      expect(pd005(outside).map((item) => item.message)).toEqual([
        "skills lock is missing",
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
