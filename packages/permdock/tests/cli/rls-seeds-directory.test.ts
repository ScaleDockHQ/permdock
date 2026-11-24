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

import {
  migrationVersion,
  nextMigrationVersion,
} from "../../src/cli/core/output-files.ts";
import { runRlsGenerate } from "../../src/cli/rls/generate.ts";

const TMP = path.join(import.meta.dirname, "../../tmp");
mkdirSync(TMP, { recursive: true });
const cwd = mkdtempSync(path.join(TMP, "rls-seeds-directory-"));
const MINI = path.join(import.meta.dirname, "fixtures/mini-app/src/policy.ts");
const io = { stdout: () => undefined, stderr: () => undefined };

describe("rls seeds directory", () => {
  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function generate(now: string, check = false, policy = MINI) {
    return runRlsGenerate({
      cwd,
      config: {
        policy,
        rls: { actions: { archive: "none", publish: "none" } },
      },
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
      const { code } = await generate("2026-10-01T08:00:00Z");
      expect(code).toBe(0);
      expect(migrations()).toStrictEqual(["20261001080000_permdock_seeds.sql"]);
      expect((await generate("2026-10-02T08:00:00Z")).code).toBe(0);
      expect(migrations()).toStrictEqual(["20261001080000_permdock_seeds.sql"]);
      expect((await generate("2026-10-02T08:00:00Z", true)).code).toBe(0);

      writeFileSync(
        path.join(cwd, "migrations/20261001090000_other.sql"),
        "select 1;\n",
      );
      const first = readFileSync(
        path.join(cwd, "migrations/20261001080000_permdock_seeds.sql"),
        "utf8",
      );
      const dropped = first
        .split("\n")
        .find((line) =>
          /^ {2}\('[^']*', '[^']*', '[^']*', '[^']*', '[^']*'\),$/u.test(line),
        );
      expect(dropped).toBeDefined();
      writeFileSync(
        path.join(cwd, "migrations/20261001080000_permdock_seeds.sql"),
        first.replace(`${dropped ?? ""}\n`, ""),
      );
      const drift = await generate("2026-10-03T08:00:00Z", true);
      expect(drift.code).toBe(1);
      expect(drift.output).toContain(
        "seeds: missing migrations/20261003080000_permdock_seeds.sql",
      );
      expect((await generate("2026-10-03T08:00:00Z")).code).toBe(0);
      expect(migrations()).toStrictEqual([
        "20261001080000_permdock_seeds.sql",
        "20261001090000_other.sql",
        "20261003080000_permdock_seeds.sql",
      ]);
      const delta = readFileSync(
        path.join(cwd, "migrations/20261003080000_permdock_seeds.sql"),
        "utf8",
      );
      expect(delta).toContain(
        "-- permdock seeds delta since 20261001080000_permdock_seeds.sql: +1, -0",
      );
      expect(delta).toContain((dropped ?? "").replace(/,$/u, ""));
      expect(delta).not.toContain("not in (values");
      expect((await generate("2026-10-04T08:00:00Z", true)).code).toBe(0);
    });

    it("leaves the seeds alone when only a comment in the newest migration changed", async () => {
      const latest =
        migrations().findLast((name) => name.endsWith("_permdock_seeds.sql")) ??
        "";
      const file = path.join(cwd, "migrations", latest);
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(
          "on conflict",
          "-- edited\non conflict",
        ),
      );
      expect((await generate("2031-01-01T00:00:00Z", true)).code).toBe(0);
    });

    it("stamps a migration at the later of now and one second past the newest", () => {
      const now = new Date("2030-01-01T00:00:00Z");
      expect(
        nextMigrationVersion(
          ["20261231235959_a.sql", "20260101000000_b.sql", "notes.txt"],
          now,
        ),
      ).toBe("20300101000000");
      expect(
        nextMigrationVersion(
          ["20261231235959_a.sql"],
          new Date("2026-06-01T00:00:00Z"),
        ),
      ).toBe("20270101000000");
      expect(nextMigrationVersion([], now)).toBe("20300101000000");
    });

    it("names a migration by its UTC version", () => {
      expect(migrationVersion(new Date("2026-10-05T21:04:09.123Z"))).toBe(
        "20261005210409",
      );
    });
  });
});
