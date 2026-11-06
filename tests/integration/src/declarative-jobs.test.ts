import { extract, plan, renderApplyScript } from "@supabase/pg-delta";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { run } from "./support/cli-run.ts";
import { ROLES } from "./support/declarative-fixtures.ts";
import { startPostgres } from "./support/postgres.ts";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/declarative-jobs",
);

describe("Lienlink declarative jobs", () => {
  it("keeps the config at or under 109 lines", () => {
    const lines = readFileSync(
      join(FIXTURE, "permdock.config.ts"),
      "utf8",
    ).split("\n");
    expect(lines.length).toBeLessThanOrEqual(109);
    const text = lines.join("\n");
    expect(text).toContain('authorize: "database"');
    expect(text).toContain('seeds: "view"');
    expect(text).toContain('split: ["helpers", "hook"]');
    expect(text).toContain("rowHelpers");
    expect(text).toContain("follows");
    expect(text).toContain('remove: "none"');
    expect(text).toContain('security: "definer"');
    expect(text).toContain("teams:");
  });

  it("plans an empty pg-delta diff after the generated schema is applied", async () => {
    const generated = await run(["generate", "--only", "rls", "--no-cache"], {
      cwd: FIXTURE,
    });
    expect(generated.code).toBe(0);
    const schema = readFileSync(
      join(FIXTURE, "supabase/schemas/permdock/helpers.sql"),
      "utf8",
    );
    expect(schema).not.toMatch(/\bdo\s+\$\$/iu);
    const db = await startPostgres();
    try {
      const declared = new URL(db.uri);
      declared.pathname = "/jobs_declared";
      await db.admin.query("create database jobs_declared");
      const applied = new URL(db.uri);
      applied.pathname = "/jobs_applied";
      await db.admin.query("create database jobs_applied");
      const apply = async (uri: string, sql: string): Promise<void> => {
        const pool = new Pool({ connectionString: uri });
        try {
          await pool.query(sql);
        } finally {
          await pool.end();
        }
      };
      await apply(declared.toString(), `${ROLES}\n${schema}`);
      await apply(applied.toString(), ROLES);
      const diff = async (): Promise<string> => {
        const source = new Pool({ connectionString: applied.toString() });
        const target = new Pool({ connectionString: declared.toString() });
        try {
          const [current, desired] = await Promise.all([
            extract(source),
            extract(target),
          ]);
          return renderApplyScript(
            plan(current.factBase, desired.factBase),
          ).trim();
        } finally {
          await Promise.all([source.end(), target.end()]);
        }
      };
      const sql = await diff();
      await apply(applied.toString(), sql);
      expect(await diff()).toBe("");
    } finally {
      await db.stop();
    }
  }, 180_000);
});
