import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { setupSql } from "../fixtures/row-hot-path/policy.ts";
import { defined } from "./support/defined.ts";
import { startPostgres } from "./support/postgres.ts";
import { jwtClaims, rlsGenerate } from "./support/rls.ts";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/row-hot-path",
);
const READER = "00000000-0000-4000-8000-000000000000";

describe("set helpers (#302)", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-set-helpers-"));
    const out = join(dir, "rls.sql");
    const generated = await rlsGenerate(["--target", "sql", "--out", out], {
      cwd: FIXTURE,
    });
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    const sql = readFileSync(out, "utf8");
    rmSync(dir, { recursive: true, force: true });
    db = await startPostgres([setupSql, sql, "analyze"]);
  }, 300_000);

  afterAll(async () => {
    await db?.stop();
  });

  async function scalar(sql: string): Promise<unknown> {
    const target = defined(db);
    return target.as(
      { role: "authenticated", settings: jwtClaims(READER) },
      async () => {
        const answer = await target.tester.query<Record<string, unknown>>(sql);
        return Object.values(answer.rows[0] ?? {})[0];
      },
    );
  }

  it("answers the ids a grant reaches as one array and asks one tenant", async () => {
    expect(
      await scalar(
        `select permdock.permitted_tenant_id_array('item.read')::text`,
      ),
    ).toBe("{org-00}");
    expect(
      await scalar(
        `select permdock.permdock_tenant_has('item.read', 'org-00')`,
      ),
    ).toBe(true);
    expect(
      await scalar(
        `select permdock.permdock_tenant_has('item.read', 'org-01')`,
      ),
    ).toBe(false);
  });

  it("reads one tenant's rows, an id list and a capped count", async () => {
    expect(
      await scalar(
        `select count(*) from permdock.permitted_item_rows('item.read', 'org-00')`,
      ),
    ).toBe("500");
    expect(
      await scalar(
        `select count(*) from permdock.permitted_item_rows('item.read', 'org-01')`,
      ),
    ).toBe("0");
    expect(
      await scalar(
        `select count(*) from permdock.permitted_item_ids_in('item.read', array((select id from public.item where "orgId" = 'org-00' limit 20) union all (select id from public.item where "orgId" = 'org-01' limit 20)))`,
      ),
    ).toBe("20");
    expect(
      await scalar(
        `select permdock.permitted_item_count('item.read', 'org-00', 100)`,
      ),
    ).toBe(100);
    expect(
      await scalar(
        `select permdock.permitted_item_count('item.read', 'org-00', 1000)`,
      ),
    ).toBe(500);
    expect(
      await scalar(
        `select permdock.permitted_item_count('item.read', 'org-01', 100)`,
      ),
    ).toBe(0);
  });
});
