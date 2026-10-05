import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/field-service",
);

const ROLES = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
`;

/**
 * Tiers and organization roles on one membership row, platform roles in
 * `user_roles`, a tenant custom role at the `own` level, and the Sync
 * Streams that sync the same rows, against one database.
 */
describe("field-service fixture", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-field-service-"));
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--dialect", "guc", "--out", out],
      { cwd: FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    const sql = readFileSync(out, "utf8");
    rmSync(dir, { recursive: true, force: true });
    db = await startPostgres([
      ROLES,
      readFileSync(join(FIXTURE, "schema.sql"), "utf8"),
      sql,
    ]);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("agrees with the policy on every fixture in the database", async () => {
    const result = await run(["rls", "verify", "--db", db!.uri], {
      cwd: FIXTURE,
    });
    expect(result.stdout).toContain("verified 12 fixture(s) in-process");
    expect(result.code).toBe(0);
  });

  it("keeps sync-config.yaml current with the policy", async () => {
    const result = await run(["powersync", "generate", "--check"], {
      cwd: FIXTURE,
    });
    expect(result.stdout).toContain("sync-config.yaml is current");
    expect(result.code).toBe(0);
  });

  it("syncs no row the policy denies", async () => {
    const result = await run(["powersync", "verify", "--db", db!.uri], {
      cwd: FIXTURE,
    });
    expect(result.stdout).toContain("no stream syncs a row the fixtures deny");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "job.read for u-dispatch: granted, not synced",
    );
    expect(result.stdout).toContain(
      "job.read for u-support: granted, not synced",
    );
  });

  it("reports no doctor finding for the streams", async () => {
    const result = await run(["doctor", "--json"], { cwd: FIXTURE });
    expect(result.stdout).not.toContain("PD058");
  });
});
