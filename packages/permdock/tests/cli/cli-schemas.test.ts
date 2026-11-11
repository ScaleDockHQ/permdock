import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PROBLEM_CODES } from "../../src/cli/core/errors.ts";
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
const result = ajv.compile(schema("cli-result-v2.json"));
const commands = ajv.compile(schema("cli-commands-v1.json"));

function expectDocument(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  result(parsed);
  expect(result.errors ?? []).toStrictEqual([]);
  // SAFETY: the schema just validated it as an object
  return parsed as Record<string, unknown>;
}

describe("schemas/cli-result-v2.json", () => {
  it("has the $id the documents name", () => {
    expect(schema("cli-result-v2.json")["$id"]).toBe(CLI_RESULT_SCHEMA);
  });

  it("lists every reason the CLI raises", () => {
    const defs = schema("cli-result-v2.json")["$defs"];
    // SAFETY: the committed schema's $defs.error.properties.reason holds an enum.
    const reason = (
      defs as { error: { properties: { reason: { enum: string[] } } } }
    ).error.properties.reason;
    expect(reason.enum).toStrictEqual([...PROBLEM_CODES]);
  });

  it("validates a success on stdout", async () => {
    const { code, stdout, stderr } = await run(
      ["catalog", "--kind", "markdown", "--json"],
      { cwd: FIXTURE },
    );
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(expectDocument(stdout)["status"]).toBe("success");
  });

  it("validates a usage error as one line on stderr", async () => {
    const { code, stdout, stderr } = await run(["nope", "--json"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(expectDocument(stderr)).toMatchObject({
      status: "error",
      reason: "unknown_command",
      userActionRequired: false,
      retryable: false,
    });
  });

  it("validates an unknown flag", async () => {
    const { stderr } = await run(["usage", "--strict", "--json"], {
      cwd: FIXTURE,
    });
    expect(expectDocument(stderr)).toMatchObject({ reason: "unknown_flag" });
  });

  it("validates an action_required error with next steps", async () => {
    const { code, stderr } = await run(["codemod", "0.5", "--agent", "yes"], {
      cwd: FIXTURE,
    });
    expect(code).toBe(2);
    expect(expectDocument(stderr)).toMatchObject({
      status: "action_required",
      reason: "confirmation_required",
      userActionRequired: true,
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
    expect(commands.errors ?? []).toStrictEqual([]);
    expect(parsed).toMatchObject({
      commands: leaves()
        .filter(({ entry }) => entry.hidden !== true)
        .map(({ path }) => ({ path: path.join(" ") })),
    });
  });

  it("validates one command's --help --json", async () => {
    const { stdout } = await run(["skills", "install", "--help", "--json"]);
    const parsed: unknown = JSON.parse(stdout);
    commands(parsed);
    expect(commands.errors ?? []).toStrictEqual([]);
  });

  it("is printed only when asked for, not by default in agent mode", async () => {
    for (const argv of [
      ["--help", "--agent", "yes"],
      ["rls", "verify", "--help", "--agent", "yes"],
    ]) {
      const { code, stdout } = await run(argv);
      expect(code).toBe(0);
      expect(stdout).toMatch(/^permdock/u);
    }
  });
});
