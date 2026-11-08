import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { projectContext } from "../../src/cli/generate/context.ts";
import { receiptRows, runGenerate } from "../../src/cli/generate/pipeline.ts";
import {
  definePlugin,
  orderPlugins,
  schemaInputs,
} from "../../src/cli/generate/plugin.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  doc: resource({
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
  roles: [role("admin", [allow(permissions.doc.read)], { on: "tenant" })],
});

const dirs: string[] = [];

function plugin(name: string, after: readonly string[] = []) {
  return definePlugin({
    name,
    version: "1",
    after,
    plan: () => [{ id: name, out: `${name}.txt` }],
    emit: (task) => [{ path: task.out, contents: `${name}\n` }],
  });
}

describe("generate pipeline", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints an unchanged row and a cache skip", () => {
    expect(
      receiptRows({
        created: 0,
        updated: 0,
        unchanged: 2,
        planned: 0,
        skipped: 1,
      }),
    ).toStrictEqual(["Unchanged 2", "Skipped (cache) 1"]);
    expect(
      receiptRows({
        created: 1,
        updated: 0,
        unchanged: 0,
        planned: 0,
        skipped: 0,
      }),
    ).toStrictEqual([]);
  });

  it("orders plugins by after and keeps input order", () => {
    const names = orderPlugins([
      plugin("b", ["a"]),
      plugin("a"),
      plugin("c"),
    ]).map((item) => item.name);
    expect(names).toStrictEqual(["a", "c", "b"]);
  });

  it("writes once, then reports unchanged, and --check writes nothing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "permdock-generate-"));
    dirs.push(cwd);
    const ctx = await projectContext(cwd);
    const first = await runGenerate({
      cwd,
      policy,
      plugins: [plugin("rules")],
      config: {},
      ctx,
      check: false,
      dryRun: false,
    });
    expect(first.files).toStrictEqual([
      {
        path: "rules.txt",
        plugin: "rules",
        outcome: "created",
        bytes: 6,
        delta: 6,
      },
    ]);
    expect(readFileSync(join(cwd, "rules.txt"), "utf8")).toBe("rules\n");
    expect(structuredClone(first.model)).toStrictEqual(first.model);

    const second = await runGenerate({
      cwd,
      policy,
      plugins: [plugin("rules")],
      config: {},
      ctx,
      check: false,
      dryRun: false,
    });
    expect(second.summary.skipped).toBe(1);
    expect(second.summary.unchanged).toBe(0);

    const check = await runGenerate({
      cwd,
      policy,
      plugins: [plugin("rules")],
      config: {},
      ctx,
      check: true,
      dryRun: false,
    });
    expect(check.code).toBe(0);
    expect(check.diff).toBe("");
  });

  it("plans a changed file with its byte delta on a dry run", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "permdock-generate-"));
    dirs.push(cwd);
    writeFileSync(join(cwd, "rules.txt"), "old text that is longer\n");
    const ctx = await projectContext(cwd);
    const dry = await runGenerate({
      cwd,
      policy,
      plugins: [plugin("rules")],
      config: {},
      ctx,
      check: false,
      dryRun: true,
      noCache: true,
    });
    expect(dry.files[0]).toMatchObject({
      outcome: "planned",
      bytes: 6,
      delta: -18,
    });
    expect(dry.diff).toBe("~ rules.txt (-18 bytes, 6 total)");
    expect(readFileSync(join(cwd, "rules.txt"), "utf8")).toBe(
      "old text that is longer\n",
    );
  });

  it("writes the same bytes with and without a cache", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "permdock-generate-"));
    dirs.push(cwd);
    const ctx = await projectContext(cwd);
    let calls = 0;
    const echo = definePlugin({
      name: "echo",
      version: "1",
      plan: () => [{ id: "a", out: "a.txt" }],
      emit: () => {
        calls += 1;
        return [{ path: "a.txt", contents: "hello\n" }];
      },
    });
    const fresh = await runGenerate({
      cwd,
      policy,
      plugins: [echo],
      config: {},
      ctx,
      check: false,
      dryRun: false,
      noCache: true,
    });
    const cacheDir = join(cwd, "cache");
    const first = await runGenerate({
      cwd,
      policy,
      plugins: [echo],
      config: {},
      ctx,
      check: false,
      dryRun: false,
      cacheDir,
    });
    const second = await runGenerate({
      cwd,
      policy,
      plugins: [echo],
      config: {},
      ctx,
      check: false,
      dryRun: false,
      cacheDir,
    });
    const bytes = readFileSync(join(cwd, "a.txt"), "utf8");
    expect(bytes).toBe("hello\n");
    expect(fresh.files[0]?.outcome).toBe("created");
    expect(first.files[0]?.outcome).toBe("unchanged");
    expect(second.summary.skipped).toBe(1);
    expect(second.summary.unchanged).toBe(0);
    expect(calls).toBe(2);
  });

  it("writes a plugin's seed files and prints its doctor findings", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "permdock-generate-"));
    dirs.push(cwd);
    const seeded = definePlugin({
      name: "seeded",
      version: "1",
      plan: () => [{ id: "a", out: "a.txt" }],
      emit: () => [{ path: "a.txt", contents: "a\n" }],
      seeds: (model) => [
        { path: "seed.txt", contents: `${String(model.roles.length)} roles\n` },
      ],
      doctor: () => [
        { code: "X001", severity: "warning", message: "check the thing" },
      ],
      commands: [{ name: "seeded", summary: "Seeds" }],
    });
    expect(seeded.commands).toStrictEqual([
      { name: "seeded", summary: "Seeds" },
    ]);
    const run = await runGenerate({
      cwd,
      policy,
      plugins: [seeded],
      config: {},
      ctx: await projectContext(cwd),
      check: false,
      dryRun: false,
      noCache: true,
    });
    expect(readFileSync(join(cwd, "seed.txt"), "utf8")).toBe("1 roles\n");
    expect(run.files.map((file) => file.path)).toStrictEqual([
      "a.txt",
      "seed.txt",
    ]);
    expect(run.notes).toStrictEqual(["X001 warning: check the thing"]);
  });

  describe("cache key", () => {
    function counted(options: unknown) {
      const calls = { n: 0 };
      const echo = definePlugin({
        name: "echo",
        version: "1",
        inputs: (ctx) => schemaInputs(ctx, options),
        plan: () => [{ id: "a", out: "a.txt" }],
        emit: () => {
          calls.n += 1;
          return [{ path: "a.txt", contents: "hello\n" }];
        },
      });
      return { calls, echo };
    }

    async function run(
      cwd: string,
      echo: ReturnType<typeof counted>["echo"],
      config: Record<string, unknown> = {},
    ) {
      return runGenerate({
        cwd,
        policy,
        plugins: [echo],
        config,
        ctx: await projectContext(cwd),
        check: false,
        dryRun: false,
        cacheDir: join(cwd, ".cache"),
      });
    }

    it("misses on a plugin option, a schema file, config.toml and a config change", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "permdock-generate-"));
      dirs.push(cwd);
      mkdirSync(join(cwd, "supabase", "schemas"), { recursive: true });
      writeFileSync(join(cwd, "supabase", "schemas", "a.sql"), "one\n");
      writeFileSync(join(cwd, "supabase", "config.toml"), "[api]\n");
      const base = counted({ out: "a" });
      await run(cwd, base.echo);
      await run(cwd, base.echo);
      expect(base.calls.n).toBe(1);

      const option = counted({ out: "b" });
      await run(cwd, option.echo);
      expect(option.calls.n).toBe(1);

      writeFileSync(join(cwd, "supabase", "schemas", "a.sql"), "two\n");
      await run(cwd, base.echo);
      expect(base.calls.n).toBe(2);

      await run(cwd, base.echo);
      expect(base.calls.n).toBe(2);
      writeFileSync(join(cwd, "supabase", "config.toml"), "[api]\nport = 1\n");
      await run(cwd, base.echo);
      expect(base.calls.n).toBe(3);

      await run(cwd, base.echo, { rls: { dialect: "neon" } });
      expect(base.calls.n).toBe(4);
      await run(cwd, base.echo, { rls: { dialect: "neon" } });
      expect(base.calls.n).toBe(4);
    });
  });

  it("skips an after name that is not configured", () => {
    expect(
      orderPlugins([plugin("b", ["a"])]).map((item) => item.name),
    ).toStrictEqual(["b"]);
  });
});
