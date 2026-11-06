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
import { executeGenerate } from "../../src/cli/generate/execute.ts";
import { withImportGraph } from "../../src/cli/generate/import-graph.ts";
import { definePlugin } from "../../src/cli/generate/plugin.ts";
import { betterSupabase } from "../../src/cli/generate/plugins/better-supabase.ts";
import { openapi } from "../../src/cli/generate/plugins/openapi.ts";
import { powersync } from "../../src/cli/generate/plugins/powersync.ts";
import { rls } from "../../src/cli/generate/plugins/rls.ts";
import { scim } from "../../src/cli/generate/plugins/scim.ts";
import { supabaseHook } from "../../src/cli/generate/plugins/supabase-hook.ts";
import { watchReply } from "../../src/cli/generate/watch-worker.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";

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
    expect(
      wrote.written.some((file) => file.endsWith("permdock.generated.ts")),
    ).toBe(true);
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
    const reply = await watchReply({ cwd, only: [], noCache: true });
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
