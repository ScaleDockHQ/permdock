import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "../src/support/postgres.ts";

import {
  drive,
  MEMBER,
  node,
  OUTSIDER,
  OWNER,
  OWNER_ROWS,
  PLATFORM,
  seedSql,
  setupSql,
} from "../fixtures/file-tree-scale/seed.ts";
import { defined } from "../src/support/defined.ts";
import { startPostgres } from "../src/support/postgres.ts";
import { jwtClaims, rlsGenerate } from "../src/support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/file-tree-scale");

const RUNS = 9;
const STATEMENTS = 40;

type Explain = {
  readonly Plan: {
    readonly "Shared Hit Blocks"?: number;
    readonly "Shared Read Blocks"?: number;
  };
  readonly "Execution Time": number;
};

type Measured = {
  readonly shape: string;
  readonly medianMs: number;
  readonly blocks: number;
};

const SHAPES: readonly { readonly shape: string; readonly sql: string }[] = [
  {
    shape: "permitted_file_node_rows('fileNode.read')",
    sql: "select count(*) from permdock.permitted_file_node_rows('fileNode.read')",
  },
  {
    shape: "one row by id through the select policy",
    sql: `select id from public.file_nodes where id = '${node(5, 100)}'`,
  },
  {
    shape: "a folder page of 50 through the select policy",
    sql: `select id from public.file_nodes where drive_id = '${drive(5, 0)}' and parent_id is null limit 50`,
  },
  {
    shape: "count(*) through the select policy",
    sql: "select count(*) from public.file_nodes",
  },
];

const USERS = { OWNER, MEMBER, PLATFORM, OUTSIDER } as const;
const PERMISSIONS = {
  fileDrive: ["fileDrive.read", "fileDrive.update"],
  fileNode: ["fileNode.read", "fileNode.update"],
} as const;
const TABLES = { fileDrive: "file_drives", fileNode: "file_nodes" } as const;
const HELPERS = { fileDrive: "file_drive", fileNode: "file_node" } as const;
/** Tenants the per-row comparison reads: owned, member, granted and foreign. */
const SAMPLE = [0, 1, 2, 3, 4, 13, 14, 20, 30, 60];
const organization = (index: number): string =>
  `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`;

const ORGANIZATION_HELPERS =
  "select (select count(*) from permdock.permitted_organization_ids('file.read')) + (select count(*) from permdock.permitted_organization_ids_by_permission('file.read')) + (select count(*) from permdock.member_organization_ids())";

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

describe("row helpers on a multi-tenant file tree", () => {
  let db: Postgres | undefined;
  const measured: Measured[] = [];
  let closurePages = 0;
  let organizationHelpersMs = 0;

  const explain = async (sql: string): Promise<Explain> => {
    const result = await defined(db).tester.query<{ "QUERY PLAN": Explain[] }>(
      `explain (analyze, buffers, format json) ${sql}`,
    );
    return defined(result.rows[0]?.["QUERY PLAN"][0]);
  };

  const ids = async (user: string, sql: string): Promise<readonly string[]> =>
    defined(db).as(
      { role: "authenticated", settings: jwtClaims(user) },
      async () =>
        (await defined(db).tester.query<{ readonly id: string }>(sql)).rows
          .map((row) => row.id)
          .toSorted(),
    );

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-file-tree-"));
    const out = join(dir, "rls.sql");
    const generated = await rlsGenerate(["--target", "sql", "--out", out], {
      cwd: FIXTURE,
    });
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    const sql = readFileSync(out, "utf8");
    rmSync(dir, { recursive: true, force: true });
    db = await startPostgres([setupSql, sql, seedSql]);
    const pages = await defined(db).admin.query<{ readonly pages: string }>(
      "select (pg_relation_size('permdock.permdock_closure') / 8192)::text as pages",
    );
    closurePages = Number(pages.rows[0]?.pages);
    for (const { shape, sql: statement } of SHAPES) {
      const plans = await defined(db).as(
        { role: "authenticated", settings: jwtClaims(OWNER) },
        async () => {
          const runs: Explain[] = [];
          for (let index = 0; index < RUNS; index += 1) {
            runs.push(await explain(statement));
          }
          return runs;
        },
      );
      const last = defined(plans.at(-1));
      measured.push({
        shape,
        medianMs: median(plans.slice(1).map((plan) => plan["Execution Time"])),
        blocks:
          (last.Plan["Shared Hit Blocks"] ?? 0) +
          (last.Plan["Shared Read Blocks"] ?? 0),
      });
    }
    organizationHelpersMs = await defined(db).as(
      { role: "authenticated", settings: jwtClaims(OWNER) },
      async () => {
        const started = performance.now();
        for (let index = 0; index < STATEMENTS; index += 1) {
          await defined(db).tester.query(ORGANIZATION_HELPERS);
        }
        return performance.now() - started;
      },
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("reports the numbers", async ({ annotate }) => {
    for (const row of measured) {
      await annotate(
        `file-tree: median of ${String(RUNS - 1)} warm runs: ${row.shape}: ${row.medianMs.toFixed(2)} ms, ${String(row.blocks)} blocks`,
      );
    }
    await annotate(
      `file-tree: ${String(STATEMENTS)} statements of the organization helpers in one transaction: ${organizationHelpersMs.toFixed(1)} ms`,
    );
    expect(measured).toHaveLength(SHAPES.length);
  });

  it("answers the rows the per-row match answers", async () => {
    const set = await ids(
      OWNER,
      "select id::text from permdock.permitted_file_node_rows('fileNode.read') id",
    );
    expect(set).toHaveLength(OWNER_ROWS);
    const admin = defined(db).admin;
    await admin.query("begin");
    const matched = await (async () => {
      try {
        await admin.query("select set_config('request.jwt.claims', $1, true)", [
          defined(jwtClaims(OWNER)["request.jwt.claims"]),
        ]);
        return (
          await admin.query<{ readonly id: string }>(
            "select id::text from public.file_nodes r where permdock.can_file_node(r, 'fileNode.read')",
          )
        ).rows
          .map((row) => row.id)
          .toSorted();
      } finally {
        await admin.query("rollback");
      }
    })();
    expect(matched).toStrictEqual(set);
    const member = await ids(
      MEMBER,
      "select id::text from permdock.permitted_file_node_rows('fileNode.read') id",
    );
    expect(member.length).toBeGreaterThan(0);
    expect(member.length).toBeLessThan(set.length);
    expect(member.every((id) => set.includes(id))).toBe(true);
  });

  it("answers like can_<resource> per row, in both set forms, for every permission and user", async () => {
    const admin = defined(db).admin;
    const sample = SAMPLE.map(organization);
    const counts: Record<string, number> = {};
    for (const [label, user] of Object.entries(USERS)) {
      await admin.query("begin");
      try {
        await admin.query("select set_config('request.jwt.claims', $1, true)", [
          defined(jwtClaims(user)["request.jwt.claims"]),
        ]);
        for (const resource of ["fileDrive", "fileNode"] as const) {
          const table = TABLES[resource];
          const helper = HELPERS[resource];
          for (const permission of PERMISSIONS[resource]) {
            const list = async (sql: string): Promise<readonly string[]> =>
              (
                await admin.query<{ readonly id: string }>(sql, [
                  permission,
                  sample,
                ])
              ).rows
                .map((row) => row.id)
                .toSorted();
            const matched = await list(
              `select r.id::text as id from public.${table} r where r.organization_id = any($2::uuid[]) and permdock.can_${helper}(r, $1)`,
            );
            const whole = await list(
              `select r.id::text as id from public.${table} r where r.organization_id = any($2::uuid[]) and r.id in (select permdock.permitted_${helper}_rows($1))`,
            );
            const tenants = await list(
              `select i::text as id from unnest($2::uuid[]) t(id) cross join lateral permdock.permitted_${helper}_rows($1, t.id) i`,
            );
            expect(whole, `${label} ${permission}`).toStrictEqual(matched);
            expect(tenants, `${label} ${permission} by tenant`).toStrictEqual(
              matched,
            );
            counts[`${label} ${permission}`] = matched.length;
          }
        }
      } finally {
        await admin.query("rollback");
      }
    }
    // The fixture reaches every branch: the global holder, the two-key update,
    // the deny on restricted nodes, and record grants without requires.
    expect(counts["PLATFORM fileNode.read"]).toBeGreaterThan(
      counts["OWNER fileNode.read"] ?? 0,
    );
    expect(counts["PLATFORM fileDrive.update"]).toBe(0);
    expect(counts["MEMBER fileDrive.update"]).toBe(0);
    expect(counts["OWNER fileDrive.update"]).toBeGreaterThan(0);
    expect(counts["OWNER fileNode.update"]).toBeLessThan(
      counts["OWNER fileNode.read"] ?? 0,
    );
    expect(counts["OUTSIDER fileNode.read"]).toBe(1);
    expect(counts["OUTSIDER fileNode.update"]).toBe(1);
  });

  it("walks the closure through its index instead of reading all of it", () => {
    const rows = defined(measured[0]);
    expect(closurePages).toBeGreaterThan(1000);
    expect(rows.blocks).toBeLessThan(closurePages);
  });
});
