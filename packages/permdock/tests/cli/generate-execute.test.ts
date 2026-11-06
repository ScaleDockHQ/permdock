import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { PolicyModel } from "../../src/cli/generate/model.ts";
import type { EmitSource } from "../../src/cli/generate/plugin.ts";
import type { GenKind, PermDockConfig } from "../../src/cli/types.ts";
import type { Policy } from "../../src/core/policy-types.ts";

import { rewriteStoredCatalog } from "../../src/cli/codemod/catalog-0.26.ts";
import { rewrite026 } from "../../src/cli/codemod/rewrite-0.26.ts";
import { run } from "../../src/cli/core/run.ts";
import { projectContext } from "../../src/cli/generate/context.ts";
import { dialectsFor } from "../../src/cli/generate/dialects.ts";
import { executeGenerate, localInput } from "../../src/cli/generate/execute.ts";
import { withImportGraph } from "../../src/cli/generate/import-graph.ts";
import { definePlugin } from "../../src/cli/generate/plugin.ts";
import { betterSupabase } from "../../src/cli/generate/plugins/better-supabase.ts";
import { openapi } from "../../src/cli/generate/plugins/openapi.ts";
import { powersync } from "../../src/cli/generate/plugins/powersync.ts";
import { rls } from "../../src/cli/generate/plugins/rls.ts";
import { scim } from "../../src/cli/generate/plugins/scim.ts";
import { supabaseHook } from "../../src/cli/generate/plugins/supabase-hook.ts";
import { watchReply } from "../../src/cli/generate/watch-worker.ts";
import { parseWatchReply } from "../../src/cli/generate/watch.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";
import { junctionMembershipSource } from "../../src/supabase/index.ts";

const permissions = definePermissions({
  note: resource({
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const policy: Policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
  roles: [role("reader", [allow(permissions.note.read)], { on: "tenant" })],
});

const POLICY_SOURCE = `import { allow, definePermissions, definePolicy, resource, role } from "permdock";

export const permissions = definePermissions({
  note: resource({
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
  roles: [role("reader", [allow(permissions.note.read)], { on: "tenant" })],
});
`;

const dirs: string[] = [];

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "permdock-execute-"));
  dirs.push(cwd);
  writeFileSync(join(cwd, "policy.ts"), POLICY_SOURCE);
  return cwd;
}

function echo(contents: string) {
  return definePlugin({
    name: "echo",
    version: "1",
    inputs: () => ({ files: ["policy.ts"], options: { contents } }),
    plan: () => [{ id: "echo", out: "echo.txt" }],
    emit: () => [{ path: "echo.txt", contents }],
  });
}

describe(executeGenerate, () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes, skips a cache hit, and --check reports drift without writing", async () => {
    const cwd = project();
    const config: PermDockConfig = { plugins: [echo("one\n")] };
    const first = await executeGenerate({
      cwd,
      config,
      policyPath: "policy.ts",
      only: [],
      check: false,
      dryRun: false,
      noCache: false,
      cacheDir: join(cwd, "cache"),
    });
    expect(first.summary).toMatchObject({ created: 1, skipped: 0 });
    expect(first.code).toBe(0);
    expect(readFileSync(join(cwd, "echo.txt"), "utf8")).toBe("one\n");
    expect(first.inputs.some((file) => file.endsWith("policy.ts"))).toBe(true);
    expect(first.inputs.some((file) => file.includes("node_modules"))).toBe(
      false,
    );
    expect(first.written).toStrictEqual([join(cwd, "echo.txt")]);

    const cached = await executeGenerate({
      cwd,
      config,
      policyPath: "policy.ts",
      only: [],
      check: false,
      dryRun: false,
      noCache: false,
      cacheDir: join(cwd, "cache"),
    });
    expect(cached.summary.created + cached.summary.updated).toBe(0);
    expect(cached.summary.skipped + cached.summary.unchanged).toBe(1);

    writeFileSync(join(cwd, "echo.txt"), "stale\n");
    const check = await executeGenerate({
      cwd,
      config,
      policyPath: "policy.ts",
      only: ["echo"],
      check: true,
      dryRun: false,
      noCache: true,
    });
    expect(check.code).toBe(1);
    expect(check.output).toContain("echo.txt");
    expect(readFileSync(join(cwd, "echo.txt"), "utf8")).toBe("stale\n");
  });

  it("plans a dry run and refuses a plugin that is not one", async () => {
    const cwd = project();
    rmSync(join(cwd, "echo.txt"), { force: true });
    const dry = await executeGenerate({
      cwd,
      config: { plugins: [echo("dry\n")] },
      policyPath: "policy.ts",
      only: [],
      check: false,
      dryRun: true,
      noCache: true,
    });
    expect(dry.summary.planned).toBe(1);
    expect(dry.code).toBe(0);
    expect(() => readFileSync(join(cwd, "echo.txt"), "utf8")).toThrow("ENOENT");

    await expect(
      executeGenerate({
        cwd,
        config: { plugins: [{}] },
        policyPath: "policy.ts",
        only: [],
        check: false,
        dryRun: false,
        noCache: true,
      }),
    ).rejects.toThrow("plugins must be an array of definePlugin() results");
  });

  it("names an unknown plugin and a missing policy", async () => {
    const cwd = project();
    await expect(
      executeGenerate({
        cwd,
        config: { plugins: [echo("x\n")] },
        policyPath: "policy.ts",
        only: ["missing"],
        check: false,
        dryRun: false,
        noCache: true,
      }),
    ).rejects.toThrow(/unknown plugin 'missing'/u);
    await expect(
      executeGenerate({
        cwd,
        config: {},
        policyPath: undefined,
        only: [],
        check: false,
        dryRun: false,
        noCache: true,
      }),
    ).rejects.toThrow(
      "generate needs policy in permdock.config.ts or --policy",
    );
  });

  it("writes constants beside the plugin output and rejects a bad kind", async () => {
    const cwd = project();
    const wrote = await executeGenerate({
      cwd,
      config: { plugins: [echo("k\n")], gen: { kinds: ["constants"] } },
      policyPath: "policy.ts",
      only: [],
      check: false,
      dryRun: false,
      noCache: true,
    });
    expect(wrote.code).toBe(0);
    expect(wrote.written.some((file) => file.endsWith("constants.ts"))).toBe(
      true,
    );
    await expect(
      executeGenerate({
        cwd,
        config: {
          plugins: [],
          // SAFETY: "nope" is not a GenKind; the test checks the runtime refusal.
          gen: { kinds: ["nope" as GenKind] },
        },
        policyPath: "policy.ts",
        only: [],
        check: false,
        dryRun: false,
        noCache: true,
      }),
    ).rejects.toThrow(/gen\.kinds has 'nope'/u);
  });

  it("emits the built-in plugins and reports a hook with no config", async () => {
    const cwd = project();
    mkdirSync(join(cwd, "app/notes"), { recursive: true });
    writeFileSync(
      join(cwd, "app/notes/route.ts"),
      "/** @permission note.read */\nexport function GET() {\n  return null;\n}\n",
    );
    writeFileSync(
      join(cwd, "openapi.json"),
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "n", version: "1" },
        paths: {},
      }),
    );
    const config: PermDockConfig = {
      policy: "policy.ts",
      plugins: [echo("p\n")],
      powersync: { resources: ["note"] },
    };
    const ran = await executeGenerate({
      cwd,
      config,
      policyPath: "policy.ts",
      only: ["echo"],
      check: false,
      dryRun: false,
      noCache: true,
    });
    const model: PolicyModel = ran.run.model;
    const source: EmitSource = { cwd, config, policy };
    const sql = await rls({ out: "rls.sql" }).emit(
      { id: "sql", out: "rls.sql" },
      model,
      source,
    );
    expect(sql.map((file) => file.contents).join("")).toContain("note.read");
    const warned = await rls({ out: "rls.sql" }).emit(
      { id: "sql", out: "rls.sql" },
      model,
      { ...source, config: { ...config, rls: { seeds: "function" } } },
    );
    expect(warned.notes?.join("\n")).toContain(".seed()");
    const tables = await scim({ out: "scim.sql" }).emit(
      { id: "schema", out: "scim.sql" },
      model,
      source,
    );
    expect(tables[0]?.contents).toMatch(/create table/iu);
    expect(
      await powersync().emit({ id: "sync", out: "sync.yaml" }, model),
    ).toStrictEqual([]);
    const streams = await powersync({ out: "sync.yaml" }).emit(
      { id: "sync", out: "sync.yaml" },
      model,
      source,
    );
    expect(streams[0]?.contents).toContain("note");
    const operations = await openapi({
      routes: "app/**/route.ts",
      operations: "src/operations.generated.ts",
    }).emit(
      { id: "operations", out: "src/operations.generated.ts" },
      model,
      source,
    );
    expect(operations[0]?.contents).toContain("note.read");
    expect(
      await openapi().emit({ id: "document", out: "out.json" }, model),
    ).toStrictEqual([]);
    await expect(
      openapi({ doc: "missing.json" }).emit(
        { id: "document", out: "out.json" },
        model,
        source,
      ),
    ).rejects.toThrow(/missing\.json/u);
    expect(betterSupabase().after).toStrictEqual(["supabaseHook"]);
    expect(
      await betterSupabase().plan(model, await projectContext(cwd)),
    ).toStrictEqual([]);
    expect(
      await betterSupabase().emit({ id: "none", out: "none" }, model),
    ).toStrictEqual([]);
    await expect(
      supabaseHook({
        out: "hook.sql",
        schemas: "migra",
        schema: "app",
        grantsOut: "grants.sql",
        activeFrom: "app_metadata.org",
        budget: "2048",
      }).emit({ id: "hook", out: "hook.sql" }, model, source),
    ).rejects.toThrow("supabase.hook");
    expect(
      await rls().emit({ id: "sql", out: "rls.sql" }, model),
    ).toStrictEqual([]);
    await expect(
      rls({ out: "rls.sql", split: ["helpers"] }).emit(
        { id: "sql", out: "rls.sql" },
        model,
        source,
      ),
    ).rejects.toThrow("{part}");
    await expect(
      rls({ grantsOut: "grants.sql" }).emit(
        { id: "sql", out: "rls.sql" },
        model,
        source,
      ),
    ).rejects.toThrow("--grants-out needs --split");
    await expect(
      rls({ seeds: { out: "seeds.sql" } }).emit(
        { id: "sql", out: "rls.sql" },
        model,
        source,
      ),
    ).rejects.toThrow("--seeds-out needs --split");
    const seeded = await rls({
      out: "rls.sql",
      schemas: "migra",
      seeds: { mode: "view" },
      rbacScaffold: "supabase",
      dialect: "supabase",
      gucPrefix: "app",
      policyName: "{table}_{op}",
      fields: "mask",
    }).emit({ id: "sql", out: "rls.sql" }, model, {
      ...source,
      config: {
        ...config,
        seeds: {
          defaults: { roles: [] },
          fixtures: {
            users: {},
            tenants: {},
            memberships: [],
            customRoles: [],
            rows: {},
          },
        },
      },
    });
    expect(seeded.map((file) => file.path).join(" ")).toContain("rls");
    const ctx = await projectContext(cwd);
    expect(await openapi().plan(model, ctx)).toStrictEqual([]);
    expect((await openapi({ doc: "a.json" }).plan(model, ctx))[0]?.id).toBe(
      "document",
    );
    expect(await powersync().inputs(ctx)).toStrictEqual({
      files: [],
      options: {},
    });
    expect((await powersync().plan(model, ctx))[0]?.out).toBe(
      "sync-config.yaml",
    );
    expect(
      await powersync().emit({ id: "sync", out: "sync.yaml" }, model),
    ).toStrictEqual([]);
    expect((await scim().inputs(ctx)).files).toStrictEqual([]);
    expect((await scim().plan(model, ctx))[0]?.out).toContain("scim.sql");
    expect((await scim({ dialect: "neon" }).plan(model, ctx))[0]?.out).toBe(
      "permdock_scim.sql",
    );
    expect((await openapi().inputs(ctx)).files).toStrictEqual([]);
    expect(
      (await openapi({ doc: "a.json", routes: "app/**" }).inputs(ctx)).files,
    ).toStrictEqual(["a.json", "app/**"]);
    expect(await betterSupabase().inputs(ctx)).toStrictEqual({
      files: [],
      options: {},
    });
    expect(await supabaseHook().inputs(ctx)).toStrictEqual({
      files: [],
      options: {},
    });
    expect((await supabaseHook().plan(model, ctx))[0]?.out).toBe(
      "supabase/permdock-hook.sql",
    );
    expect(
      await supabaseHook().emit({ id: "hook", out: "hook.sql" }, model),
    ).toStrictEqual([]);
    await expect(
      supabaseHook().emit({ id: "hook", out: "hook.sql" }, model, source),
    ).rejects.toThrow("supabase.hook");
    const hooked: EmitSource = {
      ...source,
      config: {
        ...config,
        supabase: {
          hook: {
            memberships: [
              junctionMembershipSource({
                table: "memberships",
                scope: "tenant",
                id: "org_id",
                roles: "role",
                user: "user_id",
              }),
            ],
          },
        },
      },
    };
    const written = await supabaseHook({
      out: "hook.sql",
      schemas: "migra",
    }).emit({ id: "hook", out: "hook.sql" }, model, hooked);
    expect(written).toHaveLength(0);
    expect(written.notes?.join("\n")).toContain("wrote hook.sql");
    expect(readFileSync(join(cwd, "hook.sql"), "utf8")).toContain(
      "custom_access_token",
    );
    await expect(
      supabaseHook().emit({ id: "hook", out: "hook.sql" }, model, {
        ...hooked,
        db: "postgres://127.0.0.1:1/permdock",
      }),
    ).rejects.toThrow("could not connect");
    const withDefaults = {
      ...source,
      config: {
        ...config,
        seeds: {
          defaults: {
            roles: [{ key: "reader", scope: "tenant", grants: ["note.read"] }],
          },
          fixtures: {
            users: { ada: { id: "u1", email: "a@b.c" } },
            tenants: {},
            memberships: [],
            customRoles: [],
            rows: {},
          },
        },
      },
    };
    const defaults = await rls({ out: "rls.sql", schemas: "migra" }).emit(
      { id: "sql", out: "rls.sql" },
      model,
      withDefaults,
    );
    const migration = defaults.find((file) => file.path.includes("defaults"));
    expect(migration?.contents).toContain("note.read");
    expect(defaults.some((file) => file.path.endsWith("permdock.sql"))).toBe(
      true,
    );
    mkdirSync(join(cwd, "supabase/migrations"), { recursive: true });
    writeFileSync(join(cwd, migration?.path ?? ""), migration?.contents ?? "");
    const again = await rls({ out: "rls.sql", schemas: "migra" }).emit(
      { id: "sql", out: "rls.sql" },
      model,
      withDefaults,
    );
    expect(again.some((file) => file.path.includes("defaults"))).toBe(false);
    await expect(
      rls({ seeds: false }).emit({ id: "sql", out: "rls.sql" }, model, {
        ...source,
        config: {},
      }),
    ).rejects.toThrow("needs policy");
    await expect(
      rls({ seeds: { backfill: "backfill.sql" } }).emit(
        { id: "sql", out: "rls.sql" },
        model,
        source,
      ),
    ).rejects.toThrow("rls.customRoles.from");
  });
});

describe("generate command", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function configured(): string {
    const cwd = project();
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      `import { definePlugin } from "permdock/cli";
const echo = definePlugin({
  name: "echo",
  version: "1",
  plan: () => [{ id: "echo", out: "echo.txt" }],
  emit: () => [{ path: "echo.txt", contents: "cmd\\n" }],
});
export default { policy: "./policy.ts", plugins: [echo] };
`,
    );
    return cwd;
  }

  it("refuses --watch with --check and a concurrency that is not a count", async () => {
    const cwd = configured();
    const watch = await run(["generate", "--watch", "--check"], { cwd });
    expect(watch.code).toBe(2);
    expect(watch.stderr).toContain("drop --check and --dry-run");
    const count = await run(["generate", "--concurrency", "0"], { cwd });
    expect(count.code).toBe(2);
    expect(count.stderr).toContain("positive integer");
  });

  it("accepts a concurrency, a cache directory and an explicit policy", async () => {
    const cwd = configured();
    const result = await run(
      [
        "generate",
        "--concurrency",
        "1",
        "--cache-dir",
        join(cwd, "cache"),
        "--policy",
        "policy.ts",
        "--no-cache",
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(readFileSync(join(cwd, "echo.txt"), "utf8")).toBe("cmd\n");
    const empty = await run(["generate", "--cache-dir", "", "--policy", ""], {
      cwd,
    });
    expect(empty.code).toBe(0);
  });

  it("writes the plugin file and prints the receipt", async () => {
    const cwd = configured();
    const result = await run(["generate", "--no-cache"], { cwd });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Generated 1 file");
    expect(readFileSync(join(cwd, "echo.txt"), "utf8")).toBe("cmd\n");
  });
});

describe("watch reply", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a request without a project and generates when the config is valid", async () => {
    expect(await watchReply({})).toMatchObject({
      ok: false,
      message: expect.stringContaining("no request"),
    });
    expect(await watchReply({ cwd: "/tmp", only: "echo" })).toMatchObject({
      ok: false,
    });
    const cwd = project();
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      `export default { policy: "./policy.ts", plugins: [] };\n`,
    );
    expect(
      await watchReply({
        cwd: "/tmp",
        only: [1],
        configFile: "permdock.config.ts",
        policy: "policy.ts",
        cacheDir: "/cache",
        concurrency: 2,
        noCache: false,
      }),
    ).toMatchObject({ ok: false });
    const reply = await watchReply({
      cwd,
      only: [],
      noCache: true,
      configFile: "permdock.config.ts",
      policy: "policy.ts",
      cacheDir: join(cwd, "cache"),
      concurrency: 1,
    });
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.summary.created).toBe(0);
      expect(reply.inputs.some((file) => file.endsWith("policy.ts"))).toBe(
        true,
      );
    }
  });
});

describe("import graph and dialects", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a module loaded while the hook is installed", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "mod.mjs"), "export const n = 1;\n");
    const loaded = await withImportGraph(
      () => import(pathToFileURL(join(cwd, "mod.mjs")).href),
    );
    expect(loaded.value).toMatchObject({ n: 1 });
    expect(loaded.files).toStrictEqual([...loaded.files].toSorted());
  });

  it("renders stream text for portable conditions and keeps RLS text otherwise", () => {
    const scopes = [{ name: "tenant", key: "orgId" }] as const;
    const eq = dialectsFor(
      { op: "eq", field: "status", value: "open" },
      scopes,
    );
    expect(eq?.stream).toContain("status");
    expect(eq?.stream).toContain("open");
    expect(
      dialectsFor({ op: "eq", field: "n", value: Number.NaN }, scopes)?.stream,
    ).toContain("null");
    expect(
      dialectsFor({ op: "isNull", field: "gone", value: true }, scopes)?.stream,
    ).toContain("NULL");
    expect(
      dialectsFor({ op: "in", field: "status", value: ["a", "b"] }, scopes)
        ?.stream,
    ).toContain("IN");
    expect(
      dialectsFor(
        {
          op: "and",
          conditions: [
            { op: "eq", field: "status", value: "open" },
            { op: "ne", field: "flag", value: false },
          ],
        },
        scopes,
      )?.stream,
    ).toContain("AND");
    expect(
      dialectsFor(
        { op: "not", condition: { op: "eq", field: "status", value: "open" } },
        scopes,
      )?.stream,
    ).toContain("NOT");
    const member = dialectsFor(
      { op: "memberOf", scope: "tenant", field: "orgId", roles: ["reader"] },
      scopes,
    );
    expect(member === undefined || member.stream.length > 0).toBe(true);
    const opaque = dialectsFor(
      { op: "opaque", sql: "true", fingerprint: "x" },
      scopes,
    );
    expect(opaque === undefined || opaque.stream === opaque.rls).toBe(true);
    expect(
      dialectsFor({ op: "gt", field: "n", value: 2 }, scopes)?.stream,
    ).toContain(">");
    expect(
      dialectsFor({ op: "gte", field: "n", value: 2 }, scopes)?.stream,
    ).toContain(">=");
    expect(
      dialectsFor({ op: "lt", field: "n", value: 2 }, scopes)?.stream,
    ).toContain("<");
    expect(
      dialectsFor({ op: "lte", field: "n", value: 2 }, scopes)?.stream,
    ).toContain("<=");
    expect(
      dialectsFor({ op: "eq", field: "flag", value: true }, scopes)?.stream,
    ).toContain("true");
    expect(
      dialectsFor({ op: "eq", field: "flag", value: false }, scopes)?.stream,
    ).toContain("false");
    expect(
      dialectsFor({ op: "eq", field: "gone", value: null }, scopes)?.stream,
    ).toContain("null");
    expect(
      dialectsFor({ op: "isNull", field: "gone", value: false }, scopes)
        ?.stream,
    ).toContain("NOT NULL");
    expect(
      dialectsFor({ op: "notIn", field: "status", value: ["a"] }, scopes)
        ?.stream,
    ).toContain("NOT IN");
    const refList = dialectsFor(
      { op: "in", field: "status", value: { ref: "principal.id" } },
      scopes,
    );
    expect(refList === undefined || refList.stream === refList.rls).toBe(true);
    const mixed = dialectsFor(
      { op: "in", field: "status", value: [{ ref: "principal.id" }] },
      scopes,
    );
    expect(mixed === undefined || mixed.stream === mixed.rls).toBe(true);
    expect(
      dialectsFor(
        {
          op: "or",
          conditions: [
            { op: "eq", field: "a", value: 1 },
            { op: "eq", field: "b", value: "x" },
          ],
        },
        scopes,
      )?.stream,
    ).toContain("OR");
    const blocked = dialectsFor(
      {
        op: "and",
        conditions: [
          { op: "eq", field: "a", value: 1 },
          { op: "memberOf", scope: "tenant", field: "orgId", roles: [] },
        ],
      },
      scopes,
    );
    expect(blocked === undefined || blocked.stream === blocked.rls).toBe(true);
    const hidden = dialectsFor(
      { op: "not", condition: { op: "liveSession" } },
      scopes,
    );
    expect(hidden === undefined || hidden.stream === hidden.rls).toBe(true);
    expect(
      dialectsFor(
        {
          op: "sqlFunction",
          name: "app.ok",
          args: [],
          twin: { op: "eq", field: "a", value: 1 },
        },
        scopes,
      )?.stream,
    ).toContain("=");
    for (const condition of [
      { op: "contains", field: "title", value: "x" },
      { op: "liveSession" },
      {
        op: "related",
        resource: "folder",
        relation: "viewer",
        field: "folder_id",
        depth: 0,
      },
    ] as const) {
      const rendered = dialectsFor(condition, scopes);
      expect(rendered === undefined || rendered.stream === rendered.rls).toBe(
        true,
      );
    }
    expect(
      dialectsFor(
        { op: "eq", field: "a", value: { ref: "context.user" } },
        scopes,
      ),
    ).toBeUndefined();
    // SAFETY: `and` without `conditions` is not a condition; compile throws TypeError.
    const broken = { op: "and" } as unknown as Parameters<
      typeof dialectsFor
    >[0];
    expect(() => dialectsFor(broken, scopes)).toThrow(TypeError);
  });

  it("keeps a project file and drops a dependency, a parent and a remote URL", () => {
    const cwd = "/app";
    expect(localInput(cwd, pathToFileURL("/app/policy.ts").href)).toBe(
      "/app/policy.ts",
    );
    expect(
      localInput(cwd, pathToFileURL("/app/node_modules/pkg/index.js").href),
    ).toBeUndefined();
    expect(localInput(cwd, pathToFileURL("/other/policy.ts").href)).toBe(
      undefined,
    );
    expect(localInput(cwd, "https://example.com/policy.ts")).toBeUndefined();
  });
});

describe("watch reply parser", () => {
  it("rejects a missing, failed or incomplete worker message", () => {
    expect(parseWatchReply(null)).toStrictEqual({
      ok: false,
      message: "generate worker returned nothing",
    });
    expect(parseWatchReply({ ok: false })).toStrictEqual({
      ok: false,
      message: "generate worker failed",
    });
    expect(parseWatchReply({ ok: false, message: "no policy" })).toStrictEqual({
      ok: false,
      message: "no policy",
    });
    expect(parseWatchReply({ ok: true })).toStrictEqual({
      ok: false,
      message: "generate worker returned nothing",
    });
    expect(
      parseWatchReply({
        ok: true,
        summary: {
          created: 0,
          updated: 1,
          unchanged: 2,
          planned: 3,
          skipped: 4,
        },
        written: ["echo.txt", 1],
        inputs: ["policy.ts", false],
      }),
    ).toStrictEqual({
      ok: true,
      summary: { created: 0, updated: 1, unchanged: 2, planned: 3, skipped: 4 },
      written: ["echo.txt"],
      inputs: ["policy.ts"],
    });
    expect(
      parseWatchReply({
        ok: true,
        summary: { created: "0" },
        written: [],
        inputs: [],
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("catalog v1 rewrite", () => {
  it("leaves text that is not a stored catalog and rewrites a v1 approval", () => {
    expect(rewriteStoredCatalog("not json")).toBeUndefined();
    expect(rewriteStoredCatalog("{}")).toBeUndefined();
    const source = {
      $schema: "https://permdock.com/schemas/catalog-v1.json",
      version: 1,
      resources: {},
      permissions: [],
      fingerprint: "sha-256:old",
      approvals: [{ mode: "any", distinct: false }],
    };
    const rewritten = rewriteStoredCatalog(`${JSON.stringify(source)}\n`);
    expect(rewritten?.from).toBe("catalog-v1");
    expect(rewritten?.to).toBe("catalog-v2");
    expect(rewritten?.text).toContain("catalog-v2.json");
    expect(rewritten?.text).toContain('"combine": "any"');
    expect(rewritten?.text).toContain('"mode": "confirm"');
    expect(rewritten?.text.endsWith("\n")).toBe(true);
    const bare = rewriteStoredCatalog(JSON.stringify(source));
    expect(bare?.text.endsWith("\n")).toBe(false);
  });

  it("moves tableOf onto the owner's also list", () => {
    const owned = rewrite026(
      "permdock.config.ts",
      `export default {\n  invoice: "public.invoices",\n  line: { tableOf: "invoice" },\n};\n`,
    );
    expect(owned.source).toContain('also: ["line"]');
    expect(owned.source).not.toContain("tableOf");
    const listed = rewrite026(
      "permdock.config.ts",
      `export default {\n  invoice: { table: "public.invoices", also: ["tax"] },\n  line: { tableOf: "invoice" },\n};\n`,
    );
    expect(listed.source).toContain("tax");
    expect(listed.source).toContain("line");
  });
});
