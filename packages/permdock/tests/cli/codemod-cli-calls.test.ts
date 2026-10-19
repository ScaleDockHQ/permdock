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

describe("rewriteCliCalls", () => {
  it.each([
    [
      "npx permdock@0.4 catalog --format markdown > CATALOG.md",
      "npx permdock@0.4 catalog --kind markdown > CATALOG.md",
    ],
    ["permdock catalog --format=schema", "permdock catalog --kind=json-schema"],
    [
      "pnpm exec permdock doctor --strict",
      "pnpm exec permdock doctor --fail-on warning",
    ],
    ["permdock login --write", "permdock login --scope catalog:write"],
    ["permdock scan --legacy src", "permdock scan src"],
    ["permdock rls migrate --write", "permdock rls migrate"],
    ["permdock rls migrate src", "permdock rls migrate src --dry-run"],
    [
      "permdock rls migrate --retire-out supabase/migrations/",
      "permdock rls migrate --retire-out supabase/migrations/",
    ],
    [
      "permdock openapi --from policy.ts",
      "permdock openapi emit --policy policy.ts",
    ],
    ["permdock skills --agent cursor", "permdock skills install --for cursor"],
    ["permdock arazzo --doc a.yaml", "permdock arazzo check --doc a.yaml"],
    [
      "permdock init --ui shadcn --agent mcp --src app",
      "permdock init --integration shadcn --integration mcp --out-dir app",
    ],
    [
      "permdock rls migrate --sql supabase   # dry run",
      "permdock rls migrate --sql supabase --dry-run   # dry run",
    ],
    [
      "permdock skills install --client cursor",
      "permdock skills install --for cursor",
    ],
    [
      "permdock rls verify --db $URL && permdock catalog --from p.ts",
      "permdock rls verify --db $URL && permdock catalog --permissions p.ts",
    ],
  ])("rewrites %s", (before, after) => {
    expect(shell(before)).toBe(after);
  });

  it.each([
    "permdock rls generate --db-url-stdin",
    "permdock openapi emit --policy p.ts",
    "permdock --version",
    "import { x } from 'permdock/cli'",
    "the permdock CLI writes permdock.config.ts",
    "permdock usage --db x",
  ])("leaves %s alone", (text) => {
    expect(rewriteCliCalls(text, { json: false })).toEqual({
      text,
      changes: [],
      followUps: [],
    });
  });

  it.each(["permdock catalog --format=xml", "permdock catalog --format"])(
    "reports %s, whose value it cannot map",
    (text) => {
      expect(rewriteCliCalls(text, { json: false })).toMatchObject({
        text,
        changes: [],
        followUps: [{ message: "catalog: --format is --kind since 0.5.0." }],
      });
    },
  );

  it("reports a rename that needs a person, and a value it cannot map", () => {
    const result = rewriteCliCalls(
      "permdock cloud push --environment staging\npermdock catalog --format yaml\n",
      { json: false },
    );
    expect(result.changes).toEqual([]);
    expect(result.followUps).toEqual([
      {
        line: 1,
        column: 21,
        name: "cli",
        message:
          "cloud push: --environment is --project <id>: a project id is its environment since 0.5.0.",
      },
      {
        line: 2,
        column: 18,
        name: "cli",
        message: "catalog: --format is --kind since 0.5.0.",
      },
    ]);
  });

  it("ends a package.json script at its closing quote", () => {
    const text = `{ "scripts": { "c": "permdock catalog --from \\"$P\\"", "x": "echo --from" } }`;
    expect(rewriteCliCalls(text, { json: true }).text).toBe(
      `{ "scripts": { "c": "permdock catalog --permissions \\"$P\\"", "x": "echo --from" } }`,
    );
  });

  it("leaves a connection string on the command line to a person", () => {
    const text = "permdock rls verify --db-url $DATABASE_URL";
    const result = rewriteCliCalls(text, { json: false });
    expect(result.text).toBe(text);
    expect(result.followUps).toEqual([
      {
        line: 1,
        column: 21,
        name: "cli",
        message:
          "rls verify: --db-url is --db-url-stdin or DATABASE_URL since 0.5.0.",
      },
    ]);
  });

  it("reports each change with its line and column", () => {
    expect(
      rewriteCliCalls("run: |\n  permdock doctor --strict\n", { json: false })
        .changes,
    ).toEqual([
      { line: 2, column: 19, from: "--strict", to: "--fail-on warning" },
    ]);
  });
});

describe("permdock codemod 0.5 on scripts and workflows", () => {
  it("rewrites package.json, workflows and shell scripts, and lists calls in Markdown", () => {
    const cwd = project({
      "package.json": `${JSON.stringify(
        { scripts: { catalog: "permdock catalog --from p.ts" } },
        null,
        2,
      )}\n`,
      ".github/workflows/ci.yml":
        "jobs:\n  check:\n    steps:\n      - run: npx permdock doctor --strict\n",
      "scripts/catalog.sh": "permdock catalog --format markdown > CATALOG.md\n",
      "README.md": "Run `permdock rls generate --db $URL`.\n",
    });
    const report = codemod({
      cwd,
      version: "0.5",
      paths: [],
      dryRun: false,
      force: true,
      json: true,
    });
    expect(readFileSync(join(cwd, "package.json"), "utf8")).toContain(
      '"permdock catalog --permissions p.ts"',
    );
    expect(
      readFileSync(join(cwd, ".github/workflows/ci.yml"), "utf8"),
    ).toContain("npx permdock doctor --fail-on warning");
    expect(readFileSync(join(cwd, "scripts/catalog.sh"), "utf8")).toBe(
      "permdock catalog --kind markdown > CATALOG.md\n",
    );
    expect(readFileSync(join(cwd, "README.md"), "utf8")).toBe(
      "Run `permdock rls generate --db $URL`.\n",
    );
    expect(report.files.map((file) => file.file)).toEqual([
      ".github/workflows/ci.yml",
      "package.json",
      "scripts/catalog.sh",
    ]);
    expect(report.followUps).toEqual([
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
    const script = "permdock doctor --strict\n";
    const cwd = project({ "check.sh": script });
    const result = await run(["codemod", "0.5", "--dry-run"], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--strict → --fail-on warning");
    expect(readFileSync(join(cwd, "check.sh"), "utf8")).toBe(script);
  });
});
