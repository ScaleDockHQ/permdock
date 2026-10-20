import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { runPipingDbUrl } from "./db-url.ts";
import { startPostgres } from "./support/postgres.ts";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/powersync-sources",
);

const ROLES = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
`;

/**
 * Two membership sources (a generated tier column, and role assignments
 * through `roles`), tenant custom roles at the own and team levels, and a
 * team level through a database function with a twin, against one
 * database.
 */
describe("powersync over rls.membershipSources", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-powersync-sources-"));
    const out = join(dir, "rls.sql");
    const result = await runPipingDbUrl(
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
      readFileSync(join(FIXTURE, "seed.sql"), "utf8"),
    ]);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("agrees with the policy on every fixture in the database", async () => {
    const result = await runPipingDbUrl(
      ["rls", "verify", "--db-url", db!.uri],
      { cwd: FIXTURE },
    );
    expect(result.stdout).toContain("verified 6 fixture(s) in-process");
    expect(result.code).toBe(0);
  });

  it("keeps sync-config.yaml and the manifest current with the policy", async () => {
    const result = await runPipingDbUrl(["powersync", "generate", "--check"], {
      cwd: FIXTURE,
    });
    expect(result.stdout).toContain("sync-config.yaml is current");
    expect(result.stdout).toContain("permdock-manifest.json is current");
    expect(result.code).toBe(0);
  });

  it("syncs every granted fixture row and no denied one", async () => {
    const result = await runPipingDbUrl(
      ["powersync", "verify", "--db-url", db!.uri],
      { cwd: FIXTURE },
    );
    expect(result.stdout).toContain("no stream syncs a row the fixtures deny");
    expect(result.stdout).not.toContain("granted, not synced");
    expect(result.code).toBe(0);
  });

  it("fails when a granted row does not sync and generate gave no warning", async () => {
    await db!.admin.query(
      "delete from \"permdock\".custom_role_permissions where role = 'lead'",
    );
    try {
      const result = await runPipingDbUrl(
        ["powersync", "verify", "--db-url", db!.uri],
        { cwd: FIXTURE },
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(
        "job.read for u-lead: granted, but stream job does not sync the row and generate gave no warning for it",
      );
    } finally {
      await db!.admin.query(
        "insert into \"permdock\".custom_role_permissions (tenant_id, scope, role, permission, effect, level) values ('acme', 'tenant', 'lead', 'job.read', 'allow', 'team')",
      );
    }
  });

  it("reports no doctor finding for the streams", async () => {
    const result = await runPipingDbUrl(["doctor", "--json"], { cwd: FIXTURE });
    expect(result.stdout).not.toContain("PD058");
  });
});
