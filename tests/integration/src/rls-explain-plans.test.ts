import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ROWS, setupSql } from "../fixtures/row-hot-path/policy.ts";
import { rlsGenerate } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/row-hot-path");
const PLANS = join(HERE, "../bench/plans");

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

describe(`explain (analyze, buffers) on ${String(ROWS)} rows`, () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-plans-"));
  let lite: PGlite | undefined;

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const generated = await rlsGenerate(["--target", "sql", "--out", out], {
      cwd: FIXTURE,
    });
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    lite = new PGlite();
    await lite.exec("create role tester;");
    await lite.exec(setupSql);
    await lite.exec(readFileSync(out, "utf8"));
    await lite.exec("analyze");
  }, 120_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await lite?.close();
  });

  it.each(SHAPES)(
    "writes the $name plan",
    async (shape) => {
      const db = lite;
      if (db === undefined) {
        throw new Error("PermDock: PGlite did not start");
      }
      await db.exec("begin");
      try {
        await db.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: READER, role: "authenticated" }),
        ]);
        await db.exec("set local role authenticated");
        const rows = (
          await db.query<{ readonly "QUERY PLAN": string }>(
            `explain (analyze, buffers) ${shape.sql}`,
          )
        ).rows;
        const plan = stable(rows.map((row) => row["QUERY PLAN"]).join("\n"));
        expect(plan.length).toBeGreaterThan(0);
        await expect(`${plan}\n`).toMatchFileSnapshot(
          join(PLANS, `${shape.name}.txt`),
        );
      } finally {
        await db.exec("rollback");
      }
    },
    60_000,
  );
});
