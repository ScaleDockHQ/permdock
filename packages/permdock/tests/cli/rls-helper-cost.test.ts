import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const GOLDEN = join(import.meta.dirname, "fixtures/golden");

function functions(file: string): readonly string[] {
  const sql = readFileSync(join(GOLDEN, file), "utf8");
  return sql
    .split(/(?=^create or replace function )/mu)
    .filter((chunk) => chunk.startsWith("create or replace function "))
    .map((chunk) => chunk.slice(0, chunk.indexOf("\n$$")));
}

const head = (fn: string): string => fn.slice(0, fn.indexOf("as $$"));

describe("generated helper planner settings", () => {
  it("gives every permitted_*_ids helper cost 1000", () => {
    for (const file of [
      "rbac-supabase-jwt.sql",
      "rbac-supabase-database.sql",
    ]) {
      const ids = functions(file).filter((fn) =>
        /\.permitted_\w+_ids\(/u.test(fn),
      );
      expect(ids.length).toBeGreaterThan(0);
      for (const fn of ids) {
        expect(head(fn)).toContain("cost 1000");
      }
    }
  });

  it("marks the claim-reading helpers parallel safe in jwt mode", () => {
    const ids = functions("rbac-supabase-jwt.sql").filter((fn) =>
      /\.permitted_\w+_ids\(/u.test(fn),
    );
    for (const fn of ids) {
      expect(head(fn)).toContain("cost 1000\nrows 10\nparallel safe");
    }
  });

  it("writes no memo in database mode by default, so the helpers are stable and parallel safe", () => {
    const sql = readFileSync(
      join(GOLDEN, "rbac-supabase-database.sql"),
      "utf8",
    );
    expect(sql).not.toContain("set_config(");
    const ids = functions("rbac-supabase-database.sql").filter((fn) =>
      /\.permitted_\w+_ids\(/u.test(fn),
    );
    expect(ids.length).toBeGreaterThan(0);
    for (const fn of ids) {
      expect(head(fn)).toContain("stable");
      expect(head(fn)).toContain("parallel safe");
      expect(head(fn)).toContain("rows 10");
      expect(head(fn)).toContain("set search_path = ''");
    }
  });
});
