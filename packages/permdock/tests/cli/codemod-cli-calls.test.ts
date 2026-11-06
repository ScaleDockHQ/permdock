import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { rewriteCliCalls } from "../../src/cli/codemod/cli-calls.ts";
import { codemod } from "../../src/cli/codemod/codemod.ts";
import { run } from "../../src/cli/core/run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, "../../tmp");
const temps: string[] = [];

describe("codemod cli calls", () => {
  afterAll(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function project(files: Readonly<Record<string, string>>): string {
    mkdirSync(TMP, { recursive: true });
    const dir = mkdtempSync(join(TMP, "codemod-cli-"));
    temps.push(dir);
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return dir;
  }

  function shell(text: string): string {
    return rewriteCliCalls(text, { json: false }).text;
  }

  describe(rewriteCliCalls, () => {
    it.each([
      [
        "permdock rls generate --db-url-stdin",
        "permdock generate --only rls --db-url-stdin",
      ],
      [
        "permdock rls generate --from policy.ts",
        "permdock generate --only rls --policy policy.ts",
      ],
      [
        "permdock openapi emit --policy p.ts",
        "permdock generate --only openapi --policy p.ts",
      ],
      ["permdock gen --kind zod", "permdock generate --kind zod"],
      [
        "permdock powersync generate --from policy.ts",
        "permdock generate --only powersync --policy policy.ts",
      ],
      [
        "permdock rls generate --force",
        "permdock generate --only rls --force-rls",
      ],
      [
        "permdock rls generate --rbac-scaffold",
        "permdock generate --only rls --rbac supabase",
      ],
    ])("rewrites a removed generate command %s", (before, after) => {
      expect(shell(before)).toBe(after);
    });

    it.each([
      "permdock --version",
      "import { x } from 'permdock/cli'",
      "the permdock CLI writes permdock.config.ts",
      "permdock usage --db x",
    ])("leaves %s alone", (text) => {
      expect(rewriteCliCalls(text, { json: false })).toStrictEqual({
        text,
        changes: [],
        followUps: [],
      });
    });

    it("leaves a connection string on a removed generate command to a person", () => {
      const text = "permdock rls generate --db-url $DATABASE_URL";
      const result = rewriteCliCalls(text, { json: false });
      expect(result.text).toBe(
        "permdock generate --only rls --db-url $DATABASE_URL",
      );
      expect(result.followUps).toStrictEqual([
        {
          line: 1,
          column: 23,
          name: "cli",
          message:
            "rls generate: --db-url is --db-url-stdin or DATABASE_URL since 0.5.0.",
        },
      ]);
    });

    it("reports each generate-command change with its line and column", () => {
      expect(
        rewriteCliCalls("run: |\n  permdock rls generate --force\n", {
          json: false,
        }).changes,
      ).toStrictEqual([
        {
          line: 2,
          column: 12,
          from: "rls generate",
          to: "generate --only rls",
        },
        { line: 2, column: 25, from: "--force", to: "--force-rls" },
      ]);
    });
  });

  describe("permdock codemod 0.26 on scripts", () => {
    it("rewrites a removed generate command in package.json and lists Markdown", () => {
      const cwd = project({
        "package.json": `${JSON.stringify(
          { scripts: { gen: "permdock rls generate --from p.ts" } },
          null,
          2,
        )}\n`,
        "scripts/gen.sh": "permdock powersync generate --from policy.ts\n",
        "README.md": "Run `permdock rls generate --db $URL`.\n",
      });
      const report = codemod({
        cwd,
        version: "0.26",
        paths: [],
        dryRun: false,
        force: true,
        json: true,
      });
      expect(readFileSync(join(cwd, "package.json"), "utf8")).toContain(
        '"permdock generate --only rls --policy p.ts"',
      );
      expect(readFileSync(join(cwd, "scripts/gen.sh"), "utf8")).toBe(
        "permdock generate --only powersync --policy policy.ts\n",
      );
      expect(readFileSync(join(cwd, "README.md"), "utf8")).toBe(
        "Run `permdock rls generate --db $URL`.\n",
      );
      expect(report.files.map((file) => file.file)).toStrictEqual([
        "package.json",
        "scripts/gen.sh",
      ]);
      expect(report.followUps).toStrictEqual([
        {
          file: "README.md",
          line: 1,
          column: 15,
          name: "cli",
          message: "rls generate → generate --only rls since 0.5.0",
        },
        {
          file: "README.md",
          line: 1,
          column: 28,
          name: "cli",
          message:
            "rls generate: --db is --db-url-stdin or DATABASE_URL since 0.5.0.",
        },
      ]);
    });

    it("writes nothing under --dry-run", async () => {
      const script = "permdock rls generate --force\n";
      const cwd = project({ "check.sh": script });
      const result = await run(["codemod", "0.26", "--dry-run"], { cwd });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("rls generate → generate --only rls");
      expect(readFileSync(join(cwd, "check.sh"), "utf8")).toBe(script);
    });
  });
});
