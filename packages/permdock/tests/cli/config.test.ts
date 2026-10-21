import { afterAll, describe, expect, expectTypeOf, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { run } from "../../src/cli/core/run.ts";
import { parseConfig } from "../../src/cli/project/config-schema.ts";
import { CONFIG_SHAPE } from "../../src/cli/project/config-shape.ts";
import { PERMISSIONS, project, removeProjects } from "./doctor-kit.ts";
import { jsonData } from "./envelope.ts";

describe("config", () => {
  afterAll(removeProjects);

  describe(parseConfig, () => {
    it("accepts every section and warns on keys PermDock does not read", () => {
      const parsed = parseConfig(
        {
          permissions: "./src/permissions.ts",
          collect: { srcPath: ["./src"], srcPaths: ["./lib"] },
          rls: { dialect: "supabase" },
          polcy: "./src/policy.ts",
        },
        "permdock.config.ts",
      );
      expect(parsed.config.permissions).toBe("./src/permissions.ts");
      expect(parsed.warnings).toStrictEqual([
        "permdock.config.ts: unknown key collect.srcPaths; PermDock reads srcPath, out, barrel",
        expect.stringMatching(
          /^permdock\.config\.ts: unknown key polcy; PermDock reads permissions, policy, operations, collect/u,
        ),
      ]);
    });

    it("skips a key set to undefined", () => {
      expect(
        parseConfig(
          { policy: undefined, rls: undefined },
          "permdock.config.ts",
        ),
      ).toStrictEqual({
        config: { policy: undefined, rls: undefined },
        warnings: [],
      });
    });

    it("treats a module with no default export as an empty config", () => {
      expect(parseConfig(undefined, "permdock.config.ts")).toStrictEqual({
        config: {},
        warnings: [],
      });
    });

    it.each([
      [[], "must export a config object as default"],
      [{ policy: 1 }, "policy must be a module path string"],
      [{ rls: "supabase" }, "rls must be an object"],
      [{ collect: ["./src"] }, "collect must be an object"],
    ])("rejects %j", (value, message) => {
      expect(() => parseConfig(value, "permdock.config.ts")).toThrow(message);
    });

    it.each([
      [
        { rls: { tables: ["staff"] } },
        "rls.tables must be an object, not an array",
      ],
      [
        { collect: { srcPath: "./src" } },
        "collect.srcPath must be an array, not a string",
      ],
      [
        { rls: { capabilities: "yes" } },
        "rls.capabilities must be a boolean, not a string",
      ],
      [
        { rls: { customRoles: "on" } },
        "rls.customRoles must be a boolean or an object, not a string",
      ],
    ])("rejects a value of the wrong kind in %j", (value, message) => {
      expect(() => parseConfig(value, "permdock.config.ts")).toThrow(
        expect.objectContaining({
          message: `PermDock CLI: permdock.config.ts: ${message}`,
          code: "config_invalid",
        }),
      );
    });

    it("accepts every kind a key lists", () => {
      expect(
        parseConfig(
          {
            collect: { barrel: "src/generated.ts" },
            rls: { customRoles: { from: {} }, readOnlyActors: ["agent"] },
          },
          "permdock.config.ts",
        ).warnings,
      ).toStrictEqual([]);
    });
  });

  describe("the config shape registry", () => {
    it("lists a section for every config key that is not a module path", () => {
      expectTypeOf<keyof typeof CONFIG_SHAPE>().toEqualTypeOf<
        Exclude<keyof PermDockConfig, "permissions" | "policy" | "operations">
      >();
      expect(Object.keys(CONFIG_SHAPE).toSorted()).toStrictEqual([
        "catalog",
        "collect",
        "doctor",
        "openapi",
        "powersync",
        "rls",
        "supabase",
      ]);
    });

    it("gives every key at least one kind", () => {
      for (const [section, keys] of Object.entries(CONFIG_SHAPE)) {
        for (const [key, kinds] of Object.entries(keys)) {
          expect(kinds.length, `${section}.${key}`).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("permdock config", () => {
    const cwd = project({
      "permdock.config.ts":
        "export default { permissions: './src/permissions.ts', collect: { barrel: true }, doctr: {} };\n",
      "src/permissions.ts": PERMISSIONS,
    });

    it("prints the effective config with each default", async () => {
      const result = await run(["config", "--print", "--cwd", cwd]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toStrictEqual({
        $schema: "https://permdock.com/schemas/config-report-v1.json",
        file: "permdock.config.ts",
        config: {
          permissions: "./src/permissions.ts",
          collect: { barrel: true },
          doctr: {},
        },
        resolved: {
          permissions: "./src/permissions.ts",
          policy: null,
          srcPath: ["./src"],
          catalog: "permissions.catalog.json",
          barrel: "src/permissions.generated.ts",
          migrations: [
            "supabase/migrations",
            "supabase/schemas",
            "migrations",
            "drizzle",
            "prisma/migrations",
            "db/migrations",
          ],
          sensitiveActions: [
            "approve",
            "pay",
            "settle",
            "submit",
            "transfer",
            "refund",
            "disburse",
          ],
          rlsSchema: "permdock",
        },
        warnings: [expect.stringContaining("unknown key doctr")],
      });
    });

    it("lists the warnings and exits 1 on them with --strict", async () => {
      const plain = await run(["config", "--cwd", cwd]);
      expect(plain.code).toBe(0);
      expect(plain.stdout).toContain("permdock.config.ts: 1 warning");
      const { code } = await run([
        "config",
        "--fail-on",
        "warning",
        "--cwd",
        cwd,
      ]);
      expect(code).toBe(1);
    });

    it("reads the file --config names", async () => {
      const other = project({
        "config/permdock.ts":
          "export default { policy: './src/policy.ts', catlog: {}, colect: {} };\n",
      });
      const result = await run([
        "config",
        "--config",
        "config/permdock.ts",
        "--cwd",
        other,
      ]);
      expect(result.stdout).toMatch(
        /^config\/permdock\.ts: 2 warnings\n {2}warn config\/permdock\.ts: unknown key catlog/u,
      );
      const clean = project({
        "permdock.config.mjs":
          "export default { policy: './src/policy.ts' };\n",
      });
      const { stdout } = await run(["config", "--cwd", clean]);
      expect(stdout).toBe("permdock.config.mjs: ok\n");
    });

    it("reports no config file", async () => {
      const empty = project({});
      const { stdout } = await run(["config", "--cwd", empty]);
      expect(stdout).toBe(
        "no permdock.config file; every option takes its default\n",
      );
    });

    it("warns on stderr when another command reads the config", async () => {
      const result = await run(["usage", "--cwd", cwd]);
      expect(result.stderr).toContain(
        "permdock: warning: permdock.config.ts: unknown key doctr",
      );
    });

    it("exits 2 with Problem Details on a config of the wrong shape", async () => {
      const bad = project({
        "permdock.config.ts": "export default { policy: 42 };\n",
      });
      const result = await run(["usage", "--json", "--cwd", bad]);
      expect(result.code).toBe(2);
      expect(jsonData(result.stdout)).toMatchObject({
        type: "https://permdock.com/docs/cli/errors#usage",
        detail:
          "PermDock CLI: permdock.config.ts: policy must be a module path string",
      });
    });
  });
});
