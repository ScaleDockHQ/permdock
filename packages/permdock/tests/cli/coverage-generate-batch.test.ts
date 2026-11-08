import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { run } from "../../src/cli/core/run.ts";
import { projectContext } from "../../src/cli/generate/context.ts";
import { executeGenerate } from "../../src/cli/generate/execute.ts";
import { definePlugin, orderPlugins } from "../../src/cli/generate/plugin.ts";
import { watchReply } from "../../src/cli/generate/watch-worker.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures/mini-app");

const dirs: string[] = [];

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

const ECHO_CONFIG = `import { definePlugin } from "permdock/cli";

const echo = definePlugin({
  name: "echo",
  version: "1",
  plan: () => [{ id: "echo", out: "echo.txt" }],
  emit: () => [{ path: "echo.txt", contents: "w\\n" }],
});

export default { policy: "./policy.ts", plugins: [echo] };
`;

const WATCH_CONFIG = `import { definePlugin } from "permdock/cli";

const marker = definePlugin({
  name: "marker",
  version: "0",
  plan: () => [{ id: "marker", out: "out/marker.txt" }],
  emit: (_task, model) => [
    {
      path: "out/marker.txt",
      contents: model.permissions.map((item) => item.key).sort().join("\\n") + "\\n",
    },
  ],
});

export default {
  permissions: "./src/permissions.ts",
  policy: "./src/policy.ts",
  plugins: [marker],
};
`;

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "permdock-cov-"));
  dirs.push(cwd);
  writeFileSync(join(cwd, "policy.ts"), POLICY_SOURCE);
  return cwd;
}

function plugin(name: string, after?: readonly string[]) {
  return definePlugin({
    name,
    version: "1",
    ...(after === undefined ? {} : { after }),
    plan: () => [{ id: name, out: `${name}.txt` }],
    emit: (task) => [{ path: task.out, contents: `${name}\n` }],
  });
}

function echo(contents: string) {
  return definePlugin({
    name: "echo",
    version: "1",
    plan: () => [{ id: "echo", out: "echo.txt" }],
    emit: () => [{ path: "echo.txt", contents }],
  });
}

function copyFixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), "permdock-watch-"));
  dirs.push(cwd);
  cpSync(FIXTURE, cwd, { recursive: true });
  writeFileSync(join(cwd, "permdock.config.ts"), WATCH_CONFIG);
  return cwd;
}

describe("generate coverage", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("plugin order", () => {
    it("runs a plugin with no remaining edges before one that waits", () => {
      expect(
        orderPlugins([
          plugin("b", ["missing", "a"]),
          plugin("a"),
          plugin("c", ["nope"]),
        ]).map((item) => item.name),
      ).toStrictEqual(["a", "c", "b"]);
      expect(
        orderPlugins([
          plugin("c", ["a", "b"]),
          plugin("b", ["a"]),
          plugin("a"),
        ]).map((item) => item.name),
      ).toStrictEqual(["a", "b", "c"]);
    });

    it("rejects a duplicate name and a cycle", () => {
      expect(() => orderPlugins([plugin("a"), plugin("a")])).toThrow(
        "PermDock: duplicate plugin 'a'",
      );
      expect(() =>
        orderPlugins([plugin("a"), plugin("b", ["c"]), plugin("c", ["b"])]),
      ).toThrow("PermDock: plugin after edges cycle");
    });

    it("rejects a plugin that is null or not an object", async () => {
      const cwd = project();
      await expect(
        executeGenerate({
          cwd,
          config: { plugins: [null] },
          policyPath: "policy.ts",
          only: [],
          check: false,
          dryRun: false,
          noCache: true,
        }),
      ).rejects.toThrow("plugins must be an array of definePlugin() results");
      await expect(
        executeGenerate({
          cwd,
          config: { plugins: [1] },
          policyPath: "policy.ts",
          only: [],
          check: false,
          dryRun: false,
          noCache: true,
        }),
      ).rejects.toThrow("plugins must be an array of definePlugin() results");
    });
  });

  describe("project context", () => {
    it("lists schema files and skips a directory entry", async () => {
      const cwd = project();
      mkdirSync(join(cwd, "supabase/schemas/nested"), { recursive: true });
      mkdirSync(join(cwd, "supabase/migrations/skip"), { recursive: true });
      writeFileSync(join(cwd, "supabase/schemas/a.sql"), "select 1;\n");
      writeFileSync(join(cwd, "supabase/schemas/nested/b.sql"), "select 2;\n");
      writeFileSync(join(cwd, "supabase/migrations/001.sql"), "select 3;\n");
      const ctx = await projectContext(cwd);
      expect(ctx.supabase).toBeUndefined();
      expect(ctx.supabaseError).toBeUndefined();
      expect(ctx.schemaDir).toBe("supabase/schemas");
      expect(ctx.schemaFiles).toStrictEqual([
        "supabase/schemas/a.sql",
        "supabase/schemas/nested/b.sql",
      ]);
      expect(ctx.migrations).toStrictEqual(["supabase/migrations/001.sql"]);
    });

    it("returns no schema files when the schema directory is absent", async () => {
      const cwd = project();
      const ctx = await projectContext(cwd);
      expect(ctx.supabase).toBeUndefined();
      expect(ctx.supabaseError).toBeUndefined();
      expect(ctx.schemaDir).toBeUndefined();
      expect(ctx.schemaFiles).toStrictEqual([]);
      expect(ctx.migrations).toStrictEqual([]);
    });

    it("records a config that does not parse and reads pg-delta schemas", async () => {
      const broken = project();
      mkdirSync(join(broken, "supabase"), { recursive: true });
      writeFileSync(join(broken, "supabase/config.toml"), "[\n");
      const failed = await projectContext(broken);
      expect(failed.supabase).toBeUndefined();
      expect(failed.supabaseError).toBeTypeOf("string");
      expect(failed.supabaseError?.length).toBeGreaterThan(0);
      expect(failed.schemaDir).toBeUndefined();
      expect(failed.schemaFiles).toStrictEqual([]);

      const missing = project();
      mkdirSync(join(missing, "supabase"), { recursive: true });
      writeFileSync(
        join(missing, "supabase/config.toml"),
        '[experimental.pgdelta]\ndeclarative_schema_path = "custom"\n',
      );
      const absent = await projectContext(missing);
      expect(absent.supabaseError).toBeUndefined();
      expect(absent.schemaDir).toBe("supabase/custom");
      expect(absent.schemaFiles).toStrictEqual([]);

      const present = project();
      mkdirSync(join(present, "supabase/custom/skip"), { recursive: true });
      writeFileSync(
        join(present, "supabase/config.toml"),
        '[experimental.pgdelta]\ndeclarative_schema_path = "custom"\n',
      );
      writeFileSync(join(present, "supabase/custom/table.sql"), "select 1;\n");
      const found = await projectContext(present);
      expect(found.supabaseError).toBeUndefined();
      expect(found.supabase?.pgDelta?.schemaDir).toBe("supabase/custom");
      expect(found.schemaFiles).toStrictEqual(["supabase/custom/table.sql"]);
    });
  });

  describe(executeGenerate, () => {
    it("rejects a missing policy and an empty policy path", async () => {
      const cwd = project();
      const config: PermDockConfig = { gen: { kinds: ["constants"] } };
      await expect(
        executeGenerate({
          cwd,
          config,
          policyPath: undefined,
          only: [],
          check: false,
          dryRun: false,
          noCache: true,
        }),
      ).rejects.toThrow(
        "generate needs policy in permdock.config.ts or --policy",
      );
      await expect(
        executeGenerate({
          cwd,
          config,
          policyPath: "",
          only: [],
          check: false,
          dryRun: false,
          noCache: true,
        }),
      ).rejects.toThrow(`Cannot find module '${cwd}'`);
    });

    it("keeps the plugin check code when gen is current", async () => {
      const cwd = project();
      const config: PermDockConfig = {
        plugins: [echo("one\n")],
        gen: { kinds: ["constants"] },
      };
      const wrote = await executeGenerate({
        cwd,
        config,
        policyPath: "policy.ts",
        only: [],
        check: false,
        dryRun: false,
        noCache: true,
      });
      expect(wrote.code).toBe(0);
      expect(wrote.inputs).toContain(join(cwd, "policy.ts"));
      expect(wrote.written).toContain(join(cwd, "src/permdock/constants.ts"));
      writeFileSync(join(cwd, "echo.txt"), "stale\n");
      const check = await executeGenerate({
        cwd,
        config,
        policyPath: "policy.ts",
        only: [],
        check: true,
        dryRun: false,
        noCache: true,
      });
      expect(check.code).toBe(1);
      expect(check.output).toContain("~ echo.txt");
      expect(check.output).toContain("src/permdock/constants.ts is current");
      expect(check.written).toContain(join(cwd, "echo.txt"));
      expect(check.written.some((file) => file.endsWith("constants.ts"))).toBe(
        false,
      );
      expect(readFileSync(join(cwd, "echo.txt"), "utf8")).toBe("stale\n");
    });

    it("drops an empty check diff and resolves a typed module path on a dry run", async () => {
      const cwd = project();
      const dry = await executeGenerate({
        cwd,
        config: { plugins: [echo("dry\n")], gen: { kinds: ["constants"] } },
        policyPath: "policy.ts",
        only: [],
        check: false,
        dryRun: true,
        noCache: true,
      });
      expect(dry.code).toBe(0);
      expect(dry.summary.planned).toBe(1);
      expect(dry.output).toBe(
        [
          "+ echo.txt (+4 bytes, 4 total)",
          "Would create src/permdock/constants.ts",
          "Would create src/permdock/types.ts",
          "Would create src/permdock/sql.ts",
        ].join("\n"),
      );
      expect(dry.written).toContain(join(cwd, "echo.txt"));
      expect(dry.written).toContain(join(cwd, "src/permdock/constants.ts"));
      expect(() => readFileSync(join(cwd, "echo.txt"), "utf8")).toThrow(
        "ENOENT",
      );
    });
  });

  describe("watch reply", () => {
    it("accepts a request with every option and one with none", async () => {
      const cwd = project();
      writeFileSync(join(cwd, "permdock.config.ts"), ECHO_CONFIG);
      const full = await watchReply({
        cwd,
        only: ["echo"],
        noCache: false,
        configFile: "permdock.config.ts",
        policy: "policy.ts",
        cacheDir: join(cwd, "cache"),
        concurrency: 1,
      });
      expect(full.ok).toBe(true);
      if (full.ok) {
        expect(full.inputs).toContain(join(cwd, "policy.ts"));
        expect(full.inputs).toContain(join(cwd, "permdock.config.ts"));
        expect(full.summary.created + full.summary.unchanged).toBeGreaterThan(
          0,
        );
      }
      const bare = await watchReply({ cwd, only: [], noCache: true });
      expect(bare.ok).toBe(true);
      if (bare.ok) {
        expect(bare.inputs).toContain(join(cwd, "policy.ts"));
        expect(bare.inputs).toContain(join(cwd, "permdock.config.ts"));
      }
      const emptyPolicy = await watchReply({
        cwd,
        only: [],
        noCache: true,
        policy: "",
      });
      expect(emptyPolicy.ok).toBe(true);
      if (emptyPolicy.ok) {
        expect(emptyPolicy.inputs).toContain(join(cwd, "policy.ts"));
      }
    });

    it("omits the config path when the project has no config file", async () => {
      const cwd = project();
      const reply = await watchReply({
        cwd,
        only: [],
        noCache: true,
        policy: "policy.ts",
      });
      expect(reply.ok).toBe(true);
      if (reply.ok) {
        expect(reply.inputs).toContain(join(cwd, "policy.ts"));
        expect(
          reply.inputs.some((file) => file.endsWith("permdock.config.ts")),
        ).toBe(false);
      }
    });
  });

  describe("generate --watch", () => {
    it("prints the error on stderr when the policy file is missing", async () => {
      const cwd = copyFixture();
      writeFileSync(
        join(cwd, "permdock.config.ts"),
        `export default { policy: "./missing.ts", plugins: [] };\n`,
      );
      const controller = new AbortController();
      const stdout: string[] = [];
      const stderr: string[] = [];
      try {
        const result = await run(["generate", "--watch"], {
          cwd,
          io: {
            stdout: (text) => {
              stdout.push(text);
            },
            stderr: (text) => {
              stderr.push(text);
            },
            signal: controller.signal,
          },
        });
        expect(result.code).toBe(0);
        expect(stdout.join("")).toBe("");
        expect(stderr.join("")).toContain("missing.ts");
      } finally {
        controller.abort();
      }
    }, 20_000);

    it("watches with a config, policy, cache directory and concurrency", async () => {
      const cwd = copyFixture();
      const controller = new AbortController();
      const stderr: string[] = [];
      try {
        const result = await run(
          [
            "generate",
            "--watch",
            "--config",
            "permdock.config.ts",
            "--policy",
            "src/policy.ts",
            "--cache-dir",
            join(cwd, "cache"),
            "--concurrency",
            "1",
          ],
          {
            cwd,
            io: {
              stdout: () => undefined,
              stderr: (text) => {
                stderr.push(text);
              },
              signal: controller.signal,
            },
          },
        );
        expect(result.code).toBe(0);
        expect(readFileSync(join(cwd, "out/marker.txt"), "utf8")).toContain(
          "post.read",
        );
        expect(stderr.join("")).toContain("watching for changes");
      } finally {
        controller.abort();
      }
    }, 20_000);
  });
});
