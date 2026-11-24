import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { pd125 } from "../../src/cli/doctor/pg-topo.ts";
import { resolveFromApp } from "../../src/cli/shared/app-peer.ts";

const EXAMPLE = resolve(
  import.meta.dirname,
  "../../../../apps/examples/next-better-supabase",
);
const entry = resolveFromApp(EXAMPLE, "@supabase/pg-topo");
if (entry === undefined) {
  throw new Error(
    "the example resolves @supabase/pg-topo through better-supabase",
  );
}
const PG_TOPO = resolve(dirname(entry), "..");
const SOURCE = resolve(import.meta.dirname, "../../src/cli/doctor/pg-topo.ts");

const dirs: string[] = [];

function project(
  files: Readonly<Record<string, string>>,
  install: "app" | "better-supabase" | "none" = "app",
): string {
  const cwd = mkdtempSync(join(tmpdir(), "permdock-pg-topo-"));
  dirs.push(cwd);
  writeFileSync(join(cwd, "package.json"), '{ "name": "app" }');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  const link = (dir: string): void => {
    mkdirSync(join(dir, "node_modules/@supabase"), { recursive: true });
    symlinkSync(PG_TOPO, join(dir, "node_modules/@supabase/pg-topo"));
  };
  if (install === "app") {
    link(cwd);
  } else if (install === "better-supabase") {
    const bsb = join(cwd, "node_modules/better-supabase");
    mkdirSync(bsb, { recursive: true });
    writeFileSync(
      join(bsb, "package.json"),
      '{ "name": "better-supabase", "exports": { "./package.json": "./package.json" } }',
    );
    link(bsb);
  }
  return cwd;
}

const NONE: PermDockConfig = {};

describe(pd125, () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints one info finding without @supabase/pg-topo", () => {
    const cwd = project(
      { "supabase/schemas/public/t.sql": "create table public.t (id int);" },
      "none",
    );
    // pnpm's bin shims set NODE_PATH to the virtual store, where pg-topo resolves.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "NODE_PATH"),
    );
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { pd125 } = await import(${JSON.stringify(pathToFileURL(SOURCE).href)});
console.log(JSON.stringify(await pd125({ cwd: ${JSON.stringify(cwd)}, config: {} })));`,
      ],
      { env, encoding: "utf8" },
    );
    const findings: unknown = JSON.parse(out);
    expect(findings).toStrictEqual([
      expect.objectContaining({
        code: "PD125",
        severity: "info",
        message: expect.stringContaining("@supabase/pg-topo"),
      }),
    ]);
  });

  it("resolves @supabase/pg-topo through the installed better-supabase", async () => {
    const cwd = project(
      {
        "supabase/schemas/a.sql": "create table public.t (id int);",
        "supabase/schemas/b.sql": "create table public.t (id int);",
      },
      "better-supabase",
    );
    expect(
      (await pd125({ cwd, config: NONE })).map((finding) => finding.target),
    ).toStrictEqual(["table:public:t:"]);
  });

  it("leaves out a schema that create schema if not exists repeats", async () => {
    const cwd = project({
      "supabase/schemas/a.sql": 'create schema if not exists "permdock";',
      "supabase/schemas/b.sql":
        'create schema if not exists "permdock";\ncreate table permdock.t (id int);',
    });
    expect(await pd125({ cwd, config: NONE })).toStrictEqual([]);
  });

  it("still names a schema that one plain create schema and a repeat create", async () => {
    const cwd = project({
      "supabase/schemas/a.sql": "create schema app;",
      "supabase/schemas/b.sql": "create schema if not exists app;",
      "supabase/schemas/c.sql": "create schema app;",
    });
    expect(
      (await pd125({ cwd, config: NONE })).map((finding) => finding.target),
    ).toStrictEqual(["schema::app:"]);
  });

  it("names both files of an object two statements create", async () => {
    const cwd = project({
      "supabase/schemas/a.sql": "create table public.t (id int);",
      "supabase/schemas/b.sql": "create table public.t (id int);",
    });
    const [finding] = await pd125({ cwd, config: NONE });
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain(
      "supabase/schemas/a.sql and supabase/schemas/b.sql",
    );
  });

  it("leaves out overloads pg-topo gives one key", async () => {
    const cwd = project({
      "supabase/schemas/f.sql": `create schema app;
create function app.f(p text, p_ids uuid[]) returns int language sql as $$ select 1 $$;
create function app.f(p text, p_tenant uuid) returns int language sql as $$ select 2 $$;
`,
    });
    expect(await pd125({ cwd, config: NONE })).toStrictEqual([]);
  });

  it("reports a table rls.tables names that no schema file creates", async () => {
    const cwd = project({
      "supabase/schemas/p.sql": `create policy own on public.orders for select using (true);
create policy own on auth.users for select using (true);
`,
    });
    const findings = await pd125({
      cwd,
      config: { rls: { tables: { order: { table: "orders" } } } },
    });
    expect(findings.map((finding) => finding.target)).toStrictEqual([
      "supabase/schemas/p.sql:public.orders",
    ]);
  });

  it("checks nothing outside the pg-delta workflow", async () => {
    const cwd = project({
      "supabase/schemas/a.sql": "create table public.t (id int);",
      "supabase/schemas/b.sql": "create table public.t (id int);",
    });
    expect(
      await pd125({ cwd, config: { supabase: { schemas: "migrations" } } }),
    ).toStrictEqual([]);
  });
});
