import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.join(import.meta.dirname, "..", "..", "src");

/**
 * The files that construct a `Date` themselves, each because the value must be
 * a `Date`. Every other clock read and ISO conversion goes through
 * `core/time.ts`, so a test or a store option can inject `now`.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  "core/time.ts": "the one clock and conversion module",
  "conditions/compile.ts": "ORM parameters bind a Date as a timestamp",
  "conditions/evaluate.ts": "row values from an ORM arrive as Date",
  "workflow-sdk/index.ts": "the Workflow SDK sleep takes a Date deadline",
};

const READ = /\bnew Date\(|\bDate\.now\(/u;

describe("clock reads", () => {
  it("construct a Date or read Date.now() only in core/time.ts and the allowed files", () => {
    const files = readdirSync(SRC, {
      recursive: true,
      encoding: "utf8",
    }).filter((file) => file.endsWith(".ts") && !(file in ALLOWED));
    expect(files.length).toBeGreaterThan(500);
    const offenders = files.flatMap((file) =>
      readFileSync(path.join(SRC, file), "utf8")
        .split("\n")
        .flatMap((line, index) => {
          const code = line.trimStart();
          return READ.test(line) &&
            !code.startsWith("//") &&
            !code.startsWith("*")
            ? [`${file}:${String(index + 1)}`]
            : [];
        }),
    );
    expect(offenders).toEqual([]);
  });
});
