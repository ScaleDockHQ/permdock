import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CLI_COMMANDS_SCHEMA } from "../../src/cli/core/help.ts";
import { leaves } from "../../src/cli/core/manifest.ts";
import { CLI_RESULT_SCHEMA } from "../../src/cli/core/output.ts";
import { run } from "../../src/cli/core/run.ts";

const SCHEMAS = join(import.meta.dirname, "../../schemas");
const FIXTURE = join(import.meta.dirname, "fixtures/mini-app");

function schema(name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(SCHEMAS, name), "utf8"));
  // SAFETY: the file is a JSON Schema object; ajv rejects anything else when it compiles it
  return parsed as Record<string, unknown>;
}

const ajv = new Ajv2020({ allErrors: true, strictRequired: false });
ajv.addFormat("uri", true);
const result = ajv.compile(schema("cli-result-v1.json"));
const commands = ajv.compile(schema("cli-commands-v1.json"));

function expectResult(stdout: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout);
  result(parsed);
  expect(result.errors ?? []).toEqual([]);
  // SAFETY: the schema just validated it as an object
  return parsed as Record<string, unknown>;
}

describe("schemas/cli-result-v1.json", () => {
  it("has the $id the envelope names", () => {
    expect(schema("cli-result-v1.json")["$id"]).toBe(CLI_RESULT_SCHEMA);
  });

  it("validates a success", async () => {
    const { code, stdout } = await run(
      ["catalog", "--kind", "markdown", "--json"],
      { cwd: FIXTURE },
    );
    expect(code).toBe(0);
    expect(expectResult(stdout)["status"]).toBe("success");
  });

  it("validates a usage error", async () => {
    const { code, stdout } = await run(["nope", "--json"]);
    expect(code).toBe(2);
    expect(expectResult(stdout)).toMatchObject({
      status: "error",
      error: { code: "unknown_command", exitCode: 2 },
    });
  });

  it("validates a moved flag", async () => {
    const { stdout } = await run(["usage", "--strict", "--json"], {
      cwd: FIXTURE,
    });
    expect(expectResult(stdout)).toMatchObject({
      error: { code: "flag_renamed" },
    });
  });

  it("validates an action_required result with next steps", async () => {
    const { code, stdout } = await run(["codemod", "0.5", "--agent", "yes"], {
      cwd: FIXTURE,
    });
    expect(code).toBe(3);
    expect(expectResult(stdout)).toMatchObject({
      status: "action_required",
      error: { code: "consent_required", exitCode: 3 },
      next: [{ when: "after the person agrees" }],
    });
  });
});

describe("schemas/cli-commands-v1.json", () => {
  it("has the $id the help names", () => {
    expect(schema("cli-commands-v1.json")["$id"]).toBe(CLI_COMMANDS_SCHEMA);
  });

  it("validates --help --json and lists every visible command", async () => {
    const { code, stdout } = await run(["--help", "--json"]);
    expect(code).toBe(0);
    const parsed: unknown = JSON.parse(stdout);
    commands(parsed);
    expect(commands.errors ?? []).toEqual([]);
    expect(parsed).toMatchObject({
      commands: leaves()
        .filter(({ entry }) => entry.hidden !== true)
        .map(({ path }) => ({ path: path.join(" ") })),
    });
  });

  it("is printed only when asked for, not by default in agent mode", async () => {
    for (const argv of [
      ["--help", "--agent", "yes"],
      ["rls", "generate", "--help", "--agent", "yes"],
    ]) {
      const { code, stdout } = await run(argv);
      expect(code).toBe(0);
      expect(stdout).toMatch(/^permdock/u);
    }
  });
});
