import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  findingOf,
  githubAnnotations,
  sarifLog,
} from "../../src/cli/core/output.ts";
import { run } from "../../src/cli/core/run.ts";

const dirs: string[] = [];

function legacyApp(): string {
  const cwd = mkdtempSync(join(tmpdir(), "permdock-formats-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, "src"));
  writeFileSync(
    join(cwd, "src/route.ts"),
    "export const ok = (user: { role: string }) =>\n  user.role === 'admin';\n",
  );
  return cwd;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("findingOf", () => {
  it("reads the path:line a message opens with", () => {
    expect(
      findingOf({
        code: "PD060",
        severity: "warning",
        message: "src/a.ts:12 does not parse",
      }),
    ).toStrictEqual({
      code: "PD060",
      severity: "warning",
      message: "src/a.ts:12 does not parse",
      file: "src/a.ts",
      line: 12,
    });
  });

  it("keeps an explicit file and leaves a message without a location alone", () => {
    const explicit = {
      code: "x",
      severity: "error" as const,
      message: "src/a.ts:1 broken",
      file: "other.ts",
    };
    expect(findingOf(explicit)).toBe(explicit);
    const plain = { code: "x", severity: "error" as const, message: "no file" };
    expect(findingOf(plain)).toBe(plain);
  });
});

describe("--format github and sarif", () => {
  it("annotates each legacy check with its file and line", async () => {
    const result = await run(["scan", "--format", "github"], {
      cwd: legacyApp(),
    });
    expect(result).toStrictEqual({
      code: 0,
      stdout:
        "::notice file=src/route.ts,line=2,title=legacy-check::role comparison: user.role === 'admin';\n",
      stderr: "",
    });
  });

  it("prints a SARIF 2.1.0 log", async () => {
    const result = await run(["scan", "--format", "sarif"], {
      cwd: legacyApp(),
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "permdock scan" } },
          results: [
            {
              ruleId: "legacy-check",
              level: "note",
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "src/route.ts" },
                    region: { startLine: 2 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("refuses a command that reports no findings", async () => {
    const result = await run(["collect", "--format", "sarif"], {
      cwd: legacyApp(),
    });
    expect(result).toMatchObject({
      code: 2,
      stderr:
        "--format sarif renders findings, and permdock collect reports none; use text or json\n",
    });
  });

  it("refuses --json with another --format", async () => {
    const result = await run(["scan", "--json", "--format", "github"], {
      cwd: legacyApp(),
    });
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "error",
      error: { code: "invalid_value" },
    });
  });

  it("escapes newlines, percent signs and property separators", () => {
    expect(
      githubAnnotations([
        {
          code: "a,b",
          severity: "error",
          message: "50%\nnext",
          fix: "do it",
          file: "c:d.ts",
        },
      ]),
    ).toBe("::error file=c%3Ad.ts,title=a%2Cb::50%25%0Anext%0AFix: do it");
    expect(JSON.parse(sarifLog("doctor", []))).toMatchObject({
      runs: [{ results: [], tool: { driver: { rules: [] } } }],
    });
  });
});
