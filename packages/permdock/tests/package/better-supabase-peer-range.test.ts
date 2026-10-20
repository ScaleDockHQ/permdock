import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "../../../..");
const workspace = readFileSync(path.join(REPO, "pnpm-workspace.yaml"), "utf8");
const WORKFLOWS = [
  ".github/workflows/ci.yml",
  ".github/workflows/database.yml",
];

type Version = readonly [number, number, number];

function parse(version: string): Version {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (match === null) {
    throw new Error(`not a version: ${version}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: string, b: string): number {
  const [x, y] = [parse(a), parse(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** The `better-supabase` matrix of a workflow, in file order. */
function matrixOf(file: string): readonly string[] {
  const text = readFileSync(path.join(REPO, file), "utf8");
  const list = /^\s+better-supabase: \[([^\]]*)\]$/mu.exec(text)?.[1];
  if (list === undefined) {
    throw new Error(`${file} has no better-supabase matrix`);
  }
  return list.split(",").map((entry) => entry.trim().replaceAll('"', ""));
}

const peer = /^\s+better-supabase: "([^"]*)"$/mu.exec(workspace)?.[1];
const floor = /^>=(\d+\.\d+\.\d+)$/u.exec(peer ?? "")?.[1];
const catalog = /^ {2}better-supabase: ([\d.]+)$/mu.exec(workspace)?.[1];

describe("better-supabase peer range", () => {
  it("has a floor and no upper bound", () => {
    expect(floor).toBeDefined();
  });

  for (const file of WORKFLOWS) {
    describe(file, () => {
      const matrix = matrixOf(file);
      const sorted = matrix.toSorted(compare);

      it("lists versions from lowest to latest", () => {
        expect(matrix).toEqual(sorted);
      });

      it("tests the floor of the peer range", () => {
        expect(sorted[0]).toBe(floor);
      });

      it("tests the catalog pin as the latest version", () => {
        expect(sorted.at(-1)).toBe(catalog);
      });
    });
  }

  it("runs the generated-SQL checks on the catalog pin only", () => {
    const database = readFileSync(
      path.join(REPO, ".github/workflows/database.yml"),
      "utf8",
    );
    expect(database).toContain(
      `CATALOG: \${{ matrix.better-supabase == '${catalog}' }}`,
    );
  });
});
