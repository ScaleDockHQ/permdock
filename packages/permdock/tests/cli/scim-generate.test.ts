import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";
import { scimSchemaSql } from "../../src/cli/scim/generate.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, "../../tmp");

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function project(): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, "scim-generate-"));
  temps.push(dir);
  return dir;
}

describe("scimSchemaSql", () => {
  it("keys every table on the tenant and keeps userName and externalId unique per tenant", () => {
    const sql = scimSchemaSql({ schema: "permdock", dialect: "supabase" });
    expect(sql).toContain('create table if not exists "permdock"."scim_users"');
    expect(sql).toContain("primary key (tenant, id)");
    expect(sql).toContain(
      'constraint "scim_users_user_name_key" unique (tenant, user_name)',
    );
    expect(sql).toContain(
      'constraint "scim_users_external_id_key" unique (tenant, external_id)',
    );
    expect(sql).toContain(
      'constraint "scim_groups_external_id_key" unique (tenant, external_id)',
    );
    expect(sql).toContain(
      'foreign key (tenant, group_id) references "permdock"."scim_groups" (tenant, id) on delete cascade',
    );
    expect(sql).toContain(
      'on "permdock"."scim_group_members" (tenant, user_id)',
    );
  });

  it("revokes the dialect's client roles and never names service_role", () => {
    const revoke = (dialect: "supabase" | "neon" | "guc") =>
      scimSchemaSql({ schema: "permdock", dialect })
        .split("\n")
        .find((line) => line.startsWith("revoke all"));
    expect(revoke("supabase")).toMatch(/from public, anon, authenticated;$/u);
    expect(revoke("neon")).toMatch(/from public, anonymous, authenticated;$/u);
    expect(revoke("guc")).toMatch(/from public;$/u);
    for (const dialect of ["supabase", "neon", "guc"] as const) {
      const sql = scimSchemaSql({ schema: "permdock", dialect });
      expect(sql).not.toContain("service_role");
      expect(sql.match(/enable row level security/gu)).toHaveLength(3);
    }
  });

  it("refuses a schema that is not a plain identifier", () => {
    expect(() =>
      scimSchemaSql({ schema: 'x"; drop table y; --', dialect: "guc" }),
    ).toThrow(/unsafe SQL identifier/u);
  });
});

describe("permdock scim generate", () => {
  it("writes supabase/schemas/permdock/scim.sql by default and checks it", async () => {
    const cwd = project();
    const written = await run(["scim", "generate", "--no-color"], { cwd });
    expect(written.code).toBe(0);
    expect(written.stdout).toContain("supabase/schemas/permdock/scim.sql");
    const path = join(cwd, "supabase/schemas/permdock/scim.sql");
    expect(readFileSync(path, "utf8")).toBe(
      scimSchemaSql({ schema: "permdock", dialect: "supabase" }),
    );
    const current = await run(["scim", "generate", "--check"], { cwd });
    expect(current.code).toBe(0);
    writeFileSync(path, "-- edited\n");
    const stale = await run(["scim", "generate", "--check"], { cwd });
    expect(stale.code).toBe(1);
    expect(stale.stdout).toContain("scim: supabase/schemas/permdock/scim.sql");
  });

  it("reads rls.dialect and rls.schema from the config, and --dry-run writes nothing", async () => {
    const cwd = project();
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      "export default { rls: { dialect: 'guc', schema: 'identity' } };\n",
    );
    const dry = await run(["scim", "generate", "--dry-run"], { cwd });
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("Would create permdock_scim.sql");
    expect(existsSync(join(cwd, "permdock_scim.sql"))).toBe(false);
    const printed = await run(["scim", "generate", "--out", "-"], { cwd });
    expect(printed.stdout).toContain('"identity"."scim_users"');
    expect(printed.stdout).toContain("from public;");
    const flagged = await run(
      ["scim", "generate", "--schema", "directory", "--out", "-"],
      { cwd },
    );
    expect(flagged.stdout).toContain('"directory"."scim_users"');
  });

  it("reports the files and tables in the --json envelope", async () => {
    const cwd = project();
    const result = await run(
      [
        "scim",
        "generate",
        "--dialect",
        "neon",
        "--out",
        "db/scim.sql",
        "--json",
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "success",
      data: {
        out: "db/scim.sql",
        dialect: "neon",
        tables: [
          "permdock.scim_users",
          "permdock.scim_groups",
          "permdock.scim_group_members",
        ],
        files: [{ path: "db/scim.sql", outcome: "created" }],
      },
    });
  });
});
