import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ENTRIES } from "./graph.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCRIPT = `
const failed = {};
for (const specifier of JSON.parse(process.argv[1])) {
  try {
    await import(specifier);
  } catch (error) {
    failed[specifier] = String(error?.code ?? error?.message ?? error);
  }
}
process.stdout.write(JSON.stringify(failed));
`;

describe("plain Node ESM", () => {
  it("imports every entry without a bundler, as Vitest externals and scripts do", () => {
    const specifiers = Object.keys(ENTRIES).map((entry) =>
      entry === "." ? "permdock" : `permdock/${entry.slice(2)}`,
    );
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", SCRIPT, JSON.stringify(specifiers)],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual({});
  });
});
