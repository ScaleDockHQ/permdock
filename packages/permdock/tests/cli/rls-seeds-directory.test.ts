import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { runRlsGenerate } from "../../src/cli/rls-generate.ts";
import { migrationVersion } from "../../src/cli/sql-files.ts";

const TMP = path.join(import.meta.dirname, "../../tmp");
mkdirSync(TMP, { recursive: true });
const cwd = mkdtempSync(path.join(TMP, "rls-seeds-directory-"));
const MINI = path.join(import.meta.dirname, "fixtures/mini-app/src/policy.ts");
const io = { stdout: () => undefined, stderr: () => undefined };

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function generate(now: string, check = false, policy = MINI) {
  return runRlsGenerate({
    cwd,
    config: { policy },
    target: "sql",
    dialect: "supabase",
    rbac: false,
    check,
    skipClosures: false,
    inlineFunctions: false,
    split: "helpers,seeds",
    out: "schemas/permdock_{part}.sql",
    seedsOut: "migrations/",
    io: { ...io, now: () => new Date(now) },
  });
}

const migrations = (): string[] =>
  readdirSync(path.join(cwd, "migrations")).toSorted();

describe("rls generate --seeds-out <directory>", () => {
  it("writes a new seeds migration only when the rows change", async () => {
    expect((await generate("2026-10-01T08:00:00Z")).code).toBe(0);
    expect(migrations()).toEqual(["20261001080000_permdock_seeds.sql"]);
    expect((await generate("2026-10-02T08:00:00Z")).code).toBe(0);
    expect(migrations()).toEqual(["20261001080000_permdock_seeds.sql"]);
    expect((await generate("2026-10-02T08:00:00Z", true)).code).toBe(0);

    writeFileSync(
      path.join(cwd, "migrations/20261001090000_other.sql"),
      "select 1;\n",
    );
    const first = readFileSync(
      path.join(cwd, "migrations/20261001080000_permdock_seeds.sql"),
      "utf8",
    );
    writeFileSync(
      path.join(cwd, "migrations/20261001080000_permdock_seeds.sql"),
      first.replace("on conflict", "-- edited\non conflict"),
    );
    const drift = await generate("2026-10-03T08:00:00Z", true);
    expect(drift.code).toBe(1);
    expect(drift.output).toContain(
      "seeds: missing migrations/20261003080000_permdock_seeds.sql",
    );
    expect((await generate("2026-10-03T08:00:00Z")).code).toBe(0);
    expect(migrations()).toEqual([
      "20261001080000_permdock_seeds.sql",
      "20261001090000_other.sql",
      "20261003080000_permdock_seeds.sql",
    ]);
  });

  it("names a migration by its UTC version", () => {
    expect(migrationVersion(new Date("2026-10-05T21:04:09.123Z"))).toBe(
      "20261005210409",
    );
  });
});
