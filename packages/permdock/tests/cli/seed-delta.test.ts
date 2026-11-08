import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  seedDelta,
  seedDeltaNote,
  seedsMigration,
} from "../../src/cli/core/output-files.ts";

const MARKER = "-- permdock:seeds v1";
const before = `${MARKER}\ninsert into t values\n  ('a', 'x'),\n  ('b', 'y');\n`;
const after = `${MARKER}\ninsert into t values\n  ('a', 'x'),\n  ('c', 'z'),\n  ('d', 'w');\n`;

describe("seed delta", () => {
  const dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts the rows a seeds file adds and removes", () => {
    expect(seedDelta(before, after)).toStrictEqual({ added: 2, removed: 1 });
    expect(seedDelta(after, after)).toStrictEqual({ added: 0, removed: 0 });
  });

  it("is reported for a new migration against the newest one with the marker", () => {
    const cwd = mkdtempSync(join(tmpdir(), "permdock-seed-delta-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, "migrations"));
    writeFileSync(
      join(cwd, "migrations/20260101000000_permdock_seeds.sql"),
      before,
    );
    const planned = seedsMigration(
      cwd,
      "migrations",
      MARKER,
      after,
      new Date("2026-02-01T00:00:00Z"),
    );
    expect(planned.current).toBe(false);
    expect(planned.delta).toMatchObject({ added: 2, removed: 1 });
    expect(seedDeltaNote(planned.delta ?? { added: 0, removed: 0 })).toBe(
      "seeds: +2 rows, -1 row against the newest seeds migration (20260101000000_permdock_seeds.sql)",
    );
    expect(seedDeltaNote({ added: 1, removed: 0 })).toBe(
      "seeds: +1 row, -0 rows against the newest seeds migration (none)",
    );
  });

  it("has no delta when no migration carries the marker", () => {
    const cwd = mkdtempSync(join(tmpdir(), "permdock-seed-delta-"));
    dirs.push(cwd);
    expect(
      seedsMigration(cwd, "migrations", MARKER, after, new Date()).delta,
    ).toBeUndefined();
  });
});
