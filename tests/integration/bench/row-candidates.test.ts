import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "../src/support/postgres.ts";

import { setupSql, uuid } from "../fixtures/row-candidates/policy.ts";
import { defined } from "../src/support/defined.ts";
import { startPostgres } from "../src/support/postgres.ts";
import { jwtClaims } from "../src/support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/row-candidates");

const MEMBER = uuid(0, 2);
const ARCHIVIST = uuid(0, 3);
const CANDIDATES = Array.from({ length: 200 }, (_, index) =>
  uuid(2, index * 197),
);

type Table = "item" | "space";

type Scans = Readonly<
  Record<Table, { readonly seq: number; readonly idx: number }>
>;

type Query = (
  sql: string,
  values?: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

const SCANS = `select relname, seq_scan::int as seq, coalesce(idx_scan, 0)::int as idx
from pg_stat_xact_user_tables where relname in ('item', 'space')`;

describe("permitted_<resource>_rows narrowed to candidate ids, and the row-valued form", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-row-candidates-"));
    const out = join(dir, "rls.sql");
    const generated = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: FIXTURE },
    );
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    const sql = readFileSync(out, "utf8");
    rmSync(dir, { recursive: true, force: true });
    db = await startPostgres([setupSql, sql]);
  }, 300_000);

  afterAll(async () => {
    await db?.stop();
  });

  function asUser<T>(
    user: string,
    work: (query: Query) => Promise<T>,
  ): Promise<T> {
    const target = defined(db);
    return target.as({ role: "authenticated", settings: jwtClaims(user) }, () =>
      work(async (sql, values) => {
        const result = await target.tester.query<Record<string, unknown>>(
          sql,
          values === undefined ? undefined : [...values],
        );
        return result.rows;
      }),
    );
  }

  async function ids(
    user: string,
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<readonly string[]> {
    const rows = await asUser(user, (query) => query(sql, values));
    return rows.map((row) => String(row["id"])).toSorted();
  }

  async function read(query: Query): Promise<Scans> {
    const rows = await query(SCANS);
    const of = (name: Table): { seq: number; idx: number } => {
      const row = rows.find((item) => item["relname"] === name);
      return { seq: Number(row?.["seq"] ?? 0), idx: Number(row?.["idx"] ?? 0) };
    };
    return { item: of("item"), space: of("space") };
  }

  function scansOf(
    user: string,
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<Scans> {
    return asUser(user, async (query) => {
      const before = await read(query);
      await query(sql, values);
      const after = await read(query);
      const delta = (name: Table): { seq: number; idx: number } => ({
        seq: after[name].seq - before[name].seq,
        idx: after[name].idx - before[name].idx,
      });
      return { item: delta("item"), space: delta("space") };
    });
  }

  async function candidateRows(): Promise<string> {
    const result = await defined(db).admin.query<{ rows: string }>(
      "select array_agg(i)::text as rows from public.item i where i.id = any($1::uuid[])",
      [CANDIDATES],
    );
    return result.rows[0]?.rows ?? "{}";
  }

  async function permitted(
    user: string,
    key: string,
  ): Promise<readonly string[]> {
    const full = new Set(
      await ids(user, "select id from permdock.permitted_item_rows($1) id", [
        key,
      ]),
    );
    return CANDIDATES.filter((id) => full.has(id)).toSorted();
  }

  it("answers exactly the full helper's rows among the candidates, for allows and denies", async () => {
    const mismatches: string[] = [];
    for (const [user, key] of [
      [MEMBER, "item.read"],
      [ARCHIVIST, "item.archive"],
      [ARCHIVIST, "item.read"],
    ] as const) {
      const want = await permitted(user, key);
      for (const extra of [[], ["not-a-uuid", null]]) {
        const got = await ids(
          user,
          "select id from permdock.permitted_item_rows($1, $2::text[]) id",
          [key, [...CANDIDATES, ...extra]],
        );
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          mismatches.push(
            `${user} ${key} +${String(extra.length)}: [${got.join(",")}] want [${want.join(",")}]`,
          );
        }
      }
    }
    expect(mismatches).toStrictEqual([]);
    expect((await permitted(MEMBER, "item.read")).length).toBeGreaterThan(0);
    expect(
      await ids(
        MEMBER,
        "select id from permdock.permitted_item_rows('item.read', array[]::text[]) id union all select id from permdock.permitted_item_rows('item.read', null) id",
      ),
    ).toStrictEqual([]);
  });

  it("answers the row-valued form as the full helper does", async () => {
    const rows = await candidateRows();
    for (const [user, key] of [
      [MEMBER, "item.read"],
      [ARCHIVIST, "item.archive"],
    ] as const) {
      expect(
        await ids(
          user,
          "select r.id::text as id from unnest($1::public.item[]) r where permdock.permitted_item_row(r, $2)",
          [rows, key],
        ),
      ).toStrictEqual(await permitted(user, key));
    }
  });

  it("reads the candidates and the inherited rows through their primary keys", async () => {
    const full = await scansOf(
      MEMBER,
      "select count(*) from permdock.permitted_item_rows('item.read')",
    );
    expect(full.item.seq).toBeGreaterThan(0);
    expect(full.space.seq).toBeGreaterThan(0);
    const narrowed = await scansOf(
      MEMBER,
      "select count(*) from permdock.permitted_item_rows('item.read', $1::text[])",
      [CANDIDATES],
    );
    expect(narrowed.item.seq).toBe(0);
    expect(narrowed.item.idx).toBeGreaterThan(0);
    expect(narrowed.space.seq).toBe(0);
    const rows = await scansOf(
      MEMBER,
      "select count(*) from unnest($1::public.item[]) r where permdock.permitted_item_row(r, 'item.read')",
      [await candidateRows()],
    );
    expect(rows.space.seq).toBe(0);
    expect(rows.space.idx).toBeGreaterThan(0);
  });
});
