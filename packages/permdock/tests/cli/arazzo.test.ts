import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { runArazzo } from "../../src/cli/arazzo.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures/mini-app");
const TMP = path.join(import.meta.dirname, "../../tmp");
const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type Input = Parameters<typeof runArazzo>[0];

function check(overrides: Partial<Input> = {}) {
  return runArazzo({
    cwd: FIXTURE,
    config: { permissions: "./src/permissions.ts" },
    doc: "arazzo.json",
    openapi: "openapi.json",
    workflow: undefined,
    from: undefined,
    json: false,
    ...overrides,
  });
}

describe("runArazzo usage errors", () => {
  it.each([
    [{ doc: undefined }, ["--doc"]],
    [{ openapi: undefined }, ["--openapi"]],
    [{ doc: undefined, openapi: undefined }, ["--doc", "--openapi"]],
  ] as const)(
    "asks for the missing input for %j",
    async (overrides, missing) => {
      await expect(check(overrides)).rejects.toMatchObject({
        kind: "action",
        code: "input_required",
        extensions: { missing },
      });
    },
  );

  it.each([
    [{ doc: "missing.json" }, "arazzo check: document not found"],
    [{ openapi: "missing.json" }, "arazzo check: document not found"],
    [
      { from: "./src/missing.ts" },
      "arazzo check: permissions not found: ./src/missing.ts",
    ],
    [
      { config: { permissions: "./nope.ts" } },
      "arazzo check: permissions not found: ./nope.ts",
    ],
  ] as const)("exits 2 for %j", async (overrides, output) => {
    expect(await check(overrides)).toMatchObject({ code: 2, output });
  });

  it("exits 2 on unreadable JSON", async () => {
    mkdirSync(TMP, { recursive: true });
    const dir = mkdtempSync(path.join(TMP, "arazzo-"));
    temps.push(dir);
    writeFileSync(path.join(dir, "arazzo.json"), "{ nope");
    writeFileSync(path.join(dir, "openapi.json"), "{}");
    expect(await check({ cwd: dir, config: {} })).toStrictEqual({
      code: 2,
      output: "arazzo check: unreadable JSON",
    });
  });
});

describe("runArazzo findings", () => {
  it("passes a workflow whose steps are documented", async () => {
    expect(await check()).toStrictEqual({
      code: 0,
      output: "arazzo check: all steps documented",
      findings: [],
    });
    expect(await check({ json: true })).toMatchObject({
      code: 0,
      output: JSON.stringify({
        $schema: "https://permdock.com/schemas/arazzo-report-v1.json",
        findings: [],
      }),
    });
  });

  it("lists an undocumented step, in text and JSON", async () => {
    const text = await check({ doc: "arazzo-hole.json" });
    expect(text.code).toBe(1);
    expect(text.output).toMatch(/^ghost x: undocumented \(.+\)$/u);
    const json = await check({ doc: "arazzo-hole.json", json: true });
    expect(json.code).toBe(1);
    // SAFETY: the --json output of `arazzo check` under test.
    const parsed = JSON.parse(json.output) as {
      readonly $schema: string;
      readonly findings: readonly {
        readonly workflowId: string;
        readonly stepId: string;
        readonly reason: string;
      }[];
    };
    expect(parsed).toMatchObject({
      $schema: "https://permdock.com/schemas/arazzo-report-v1.json",
      findings: [{ workflowId: "ghost", stepId: "x", reason: "undocumented" }],
    });
  });

  it("checks only the workflow passed with --workflow", async () => {
    expect(await check({ workflow: "deletePost" })).toMatchObject({
      code: 0,
      output: "arazzo check: all steps documented",
    });
    expect(
      await check({ doc: "arazzo-hole.json", workflow: "deletePost" }),
    ).toStrictEqual({
      code: 1,
      output: "deletePost document: validation (unknown workflowId deletePost)",
      findings: [
        {
          code: "validation",
          severity: "error",
          message: "deletePost document: unknown workflowId deletePost",
          file: "arazzo-hole.json",
          docs: "https://permdock.com/docs/cli/arazzo",
        },
      ],
    });
  });

  it("checks without a permissions module", async () => {
    expect((await check({ config: {} })).code).toBe(0);
    expect(
      (await check({ config: {}, from: "./src/permissions.ts" })).code,
    ).toBe(0);
  });
});
