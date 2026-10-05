import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { scanSources } from "../../src/cli/scan.ts";
import { project, removeProjects } from "./doctor-kit.ts";

vi.mock(import("oxc-parser"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    parseSync: (file: string, source: string) => {
      if (file.endsWith("throws.ts")) {
        throw new Error("parser crashed");
      }
      if (file.endsWith("throws-value.ts")) {
        const thrown: unknown = "native failure";
        throw thrown;
      }
      const result = actual.parseSync(file, source);
      if (!file.endsWith("unlabelled.ts")) {
        return result;
      }
      const errors = [
        {
          severity: "Error" as const,
          message: "unexpected token",
          labels: [],
          helpMessage: null,
          codeframe: null,
        },
      ];
      return new Proxy(result, {
        get: (target, key) =>
          key === "errors" ? errors : Reflect.get(target, key),
      });
    },
  };
});

afterAll(removeProjects);

describe("scanSources parse failures", () => {
  it("reports a file the parser throws on and keeps scanning the rest", () => {
    const files = {
      "throws.ts": "export const a = 1;",
      "throws-value.ts": "export const b = 1;",
      "unlabelled.ts": "const = ;",
      "ok.ts": "can(permissions.post.read);",
    };
    const cwd = project(files);
    const result = scanSources(
      cwd,
      Object.keys(files).map((file) => path.join(cwd, file)),
      new Set(["post.read"]),
    );
    expect(result.unparsed).toEqual([
      { file: "throws.ts", line: 1, message: "parser crashed" },
      { file: "throws-value.ts", line: 1, message: "native failure" },
      { file: "unlabelled.ts", line: 1, message: "unexpected token" },
    ]);
    expect(Object.keys(result.usages)).toEqual(["post.read"]);
  });
});
