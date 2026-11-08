import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "../src/support/postgres.ts";

import { setupSql } from "../fixtures/row-hot-path/policy.ts";
import { defined } from "../src/support/defined.ts";
import { startPostgres } from "../src/support/postgres.ts";
import { jwtClaims, rlsGenerate } from "../src/support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = {
  memo: join(HERE, "../fixtures/row-hot-path"),
  none: join(HERE, "../fixtures/row-hot-path-nomemo"),
} as const;
const PLANS = join(HERE, "plans");

const READER = "00000000-0000-4000-8000-000000000000";
const KNOWN = "00000000-0000-4000-8002-000000000000";

const SHAPES = [
  {
    name: "rows",
    sql: `select count(*) from public.item where id in (select permdock.permitted_item_rows('item.read'))`,
  },
  {
    name: "row-known-id",
    sql: `select permdock.can_item(id, 'item.read') from public.item where id = '${KNOWN}'`,
  },
  {
    name: "scope-ids",
    sql: `select count(*) from public.item where "orgId" in (select permdock.permitted_tenant_ids('item.read'))`,
  },
  {
    name: "scope-ids-any",
    sql: `select count(*) from public.item where "orgId" = any(array(select permdock.permitted_tenant_ids('item.read')))`,
  },
] as const;

/**
 * The plan's shape and counts, without the timings and buffer counts that vary
 * from run to run, so a plan regression shows in the diff.
 */
function stable(plan: string): string {
  return plan
    .split("\n")
    .filter(
      (line) =>
        !/^\s*(Planning Time|Execution Time|Planning:|\s*Buffers:)/u.test(line),
    )
    .map((line) =>
      line
        .replaceAll(/\(cost=[^)]*\)/gu, "(cost=…)")
        .replaceAll(/actual time=[0-9.]+\.\.[0-9.]+/gu, "actual time=…")
        .replaceAll(/Memory: \d+kB/gu, "Memory: …")
        .replaceAll(
          /Buckets: \d+( \(originally \d+\))?\s+Batches: \d+/gu,
          "Buckets: …",
        ),
    )
    .join("\n");
}

describe.each(["memo", "none"] as const)(
  "explain (analyze, buffers) on Postgres with memo %s",
  (mode) => {
    let db: Postgres | undefined;

    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), "permdock-plans-"));
      const out = join(dir, "rls.sql");
      const generated = await rlsGenerate(["--target", "sql", "--out", out], {
        cwd: FIXTURES[mode],
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

    it.each(SHAPES)(
      "writes the $name plan",
      async (shape) => {
        const target = defined(db);
        const plan = await target.as(
          { role: "authenticated", settings: jwtClaims(READER) },
          async () =>
            (
              await target.tester.query<{ readonly "QUERY PLAN": string }>(
                `explain (analyze, buffers) ${shape.sql}`,
              )
            ).rows
              .map((row) => row["QUERY PLAN"])
              .join("\n"),
        );
        expect(plan.length).toBeGreaterThan(0);
        const file = mode === "memo" ? shape.name : `${shape.name}.nomemo`;
        await expect(`${stable(plan)}\n`).toMatchFileSnapshot(
          join(PLANS, `${file}.txt`),
        );
        const hit = /Buffers: shared hit=(\d+)/u.exec(plan)?.[1];
        const time = /Execution Time: ([\d.]+) ms/u.exec(plan)?.[1];
        process.stdout.write(
          `PLAN-NUMBERS ${mode} ${shape.name} execution_ms=${time ?? "?"} shared_hit=${hit ?? "?"}\n`,
        );
      },
      60_000,
    );
  },
);
