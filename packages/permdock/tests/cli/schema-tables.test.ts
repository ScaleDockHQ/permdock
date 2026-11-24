import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { pd134, pd135 } from "../../src/cli/doctor/schema-tables.ts";
import {
  pluralTableName,
  restatedSchemaDefaults,
  schemaTables,
  withSchemaDefaults,
} from "../../src/cli/sql/schema-tables.ts";
import { definePermissions, definePolicy, resource } from "../../src/index.ts";

const permissions = definePermissions({
  teamMember: resource({ actions: ["read"] }),
  category: resource({ actions: ["read"] }),
  doc: resource({ actions: ["read"] }),
  ghost: resource({ actions: ["read"] }),
});
const policy = definePolicy(permissions, {
  scopes: { organization: { key: "organization_id" } },
  subject: () => null,
});

const dirs: string[] = [];

function project(sql: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "permdock-schema-tables-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, "supabase/schemas/permdock"), { recursive: true });
  writeFileSync(join(cwd, "supabase/schemas/app.sql"), sql);
  writeFileSync(
    join(cwd, "supabase/schemas/permdock/helpers.sql"),
    "create table public.ghosts (id uuid);",
  );
  return cwd;
}

const SQL = `
create table public.organizations (id text primary key);
create table public.team_members (id uuid primary key, organization_id text);
create table public.categories (id int4 primary key);
create table public.doc (id uuid primary key);
`;

describe(pluralTableName, () => {
  it("writes the snake_case plural", () => {
    expect(
      ["teamMember", "category", "status", "key", "invoice-line"].map((name) =>
        pluralTableName(name),
      ),
    ).toStrictEqual([
      "team_members",
      "categories",
      "statuses",
      "keys",
      "invoice_lines",
    ]);
  });
});

describe(withSchemaDefaults, () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads tables and column types from the schema files, not the generated ones", async () => {
    const tables = await schemaTables(project(SQL));
    expect([...tables.keys()].toSorted()).toStrictEqual([
      "public.categories",
      "public.doc",
      "public.organizations",
      "public.team_members",
    ]);
    expect(tables.get("public.categories")?.get("id")).toBe("int4");
  });

  it("maps a resource to its plural table and a scope to its id type", async () => {
    const config = await withSchemaDefaults(
      project(SQL),
      { rls: { tables: { category: "public.categories" } } },
      policy,
    );
    expect(config.rls?.tables).toStrictEqual({
      teamMember: "team_members",
      category: "public.categories",
    });
    expect(config.rls?.scopeTypes).toStrictEqual({ organization: "text" });
  });

  it("reads the nearest Supabase project above a package in the same checkout", async () => {
    const root = project(SQL);
    writeFileSync(join(root, "supabase/config.toml"), "");
    mkdirSync(join(root, ".git"));
    const app = join(root, "packages/identity");
    mkdirSync(join(app, ".git"), { recursive: true });
    expect((await schemaTables(app)).size).toBe(0);
    rmSync(join(app, ".git"), { recursive: true });
    expect((await schemaTables(app)).has("public.team_members")).toBe(true);
  });

  it("names the tables and id types the schema files resolve to the same value", async () => {
    const tables = await schemaTables(project(SQL));
    const config = {
      rls: {
        tables: {
          category: "public.categories",
          teamMember: "team_members",
          doc: "documents",
        },
        scopeTypes: { organization: "text" as const },
      },
    };
    expect(restatedSchemaDefaults(config, policy, tables)).toStrictEqual([
      ["rls", "tables", "category"],
      ["rls", "tables", "teamMember"],
      ["rls", "scopeTypes", "organization"],
    ]);
  });

  it("keeps the config without schema files", async () => {
    const config = { rls: {} };
    const cwd = mkdtempSync(join(tmpdir(), "permdock-schema-tables-"));
    dirs.push(cwd);
    expect(await withSchemaDefaults(cwd, config, policy)).toBe(config);
  });

  it("reports a resource whose table neither name finds as PD134", async () => {
    const findings = await pd134({
      cwd: project(SQL),
      config: { policy: "./policy.ts", rls: {} },
      policy: () => Promise.resolve(policy),
    });
    expect(findings.map((finding) => finding.target)).toStrictEqual([
      "rls.tables.ghost",
    ]);
  });

  it("suggests rls.seeds: 'view' for a pg-delta project as PD135", () => {
    const cwd = project(SQL);
    writeFileSync(
      join(cwd, "supabase/config.toml"),
      "[experimental.pgdelta]\nenabled = true\n",
    );
    const input = (rls: Record<string, unknown>) => ({
      cwd,
      config: { policy: "./policy.ts", rls },
      policy: () => Promise.resolve(policy),
    });
    expect(pd135(input({})).map((finding) => finding.code)).toStrictEqual([
      "PD135",
    ]);
    expect(pd135(input({ seeds: "view" }))).toStrictEqual([]);
    expect(pd135({ ...input({}), cwd: project(SQL) })).toStrictEqual([]);
  });
});
