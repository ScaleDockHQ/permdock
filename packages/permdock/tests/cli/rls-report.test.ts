import { afterEach, describe, expect, it } from "vitest";

import { pd131 } from "../../src/cli/doctor/policy-count.ts";
import {
  NON_LEAKPROOF_INDEXED_SQL,
  REPORT_POLICIES_SQL,
  rlsReport,
  runRlsReport,
} from "../../src/cli/rls/report.ts";
import { fakeSql } from "../fakes/sql.ts";
import { project, removeProjects } from "./doctor-kit.ts";

const MIGRATION = "supabase/migrations/20260101000000_init.sql";

describe("rls report", () => {
  afterEach(removeProjects);

  describe("rlsReport from files", () => {
    it("lists each table's policies with origin, helpers and keys, and sorts by helper calls", async () => {
      const cwd = project({
        [MIGRATION]: [
          `create policy notes_read on public.notes for select to authenticated using (true);`,
          `create policy old on public.orders for select to authenticated using (true);`,
          `drop policy old on public.orders;`,
          `create policy orders_read on public.orders for select to authenticated using (org_id in (select permdock.permitted_organization_ids('order.read')) and note <> ';');`,
          `create policy "public_orders_update_read_only_actors" on "public"."orders" as restrictive for update to authenticated using ((select permdock.permdock_actor_may_write()));`,
          `create policy bsb_orders_guard on public.orders for all to authenticated using (true);`,
        ].join("\n"),
      });
      const report = await rlsReport({ cwd, config: {} });
      expect(report.source).toBe("files");
      expect(report.tables.map((table) => table.table)).toStrictEqual([
        "public.orders",
        "public.notes",
      ]);
      const [orders] = report.tables;
      expect(orders?.helperCallsPerStatement).toStrictEqual({
        select: 1,
        insert: 0,
        update: 1,
        delete: 0,
      });
      expect(
        orders?.policies.map((policy) => [
          policy.name,
          policy.commands,
          policy.permissive,
          policy.origin,
          policy.helpers,
          policy.keys,
          policy.line,
        ]),
      ).toStrictEqual([
        [
          "bsb_orders_guard",
          ["select", "insert", "update", "delete"],
          true,
          "library",
          [],
          [],
          6,
        ],
        [
          "orders_read",
          ["select"],
          true,
          "provider",
          ["permdock.permitted_organization_ids"],
          ["order.read"],
          4,
        ],
        [
          "public_orders_update_read_only_actors",
          ["update"],
          false,
          "provider",
          ["permdock.permdock_actor_may_write"],
          [],
          5,
        ],
      ]);
      expect(report.totals).toStrictEqual({
        policies: 4,
        library: 1,
        provider: 2,
        app: 1,
      });
    });

    it("stops on a file libpg_query rejects, naming the file and line", async () => {
      const cwd = project({ [MIGRATION]: "select 1;\nthis is not sql;" });
      const result = await runRlsReport({ cwd, config: {} });
      expect(result).toMatchObject({ code: 2, reason: "usage" });
      expect(result.output).toContain(`${MIGRATION}: syntax error`);
      expect(result.output).toContain("(line 2, column 1)");
    });
  });

  describe("rlsReport from the database", () => {
    it("reads pg_policies and lists the indexed columns whose = is not leakproof", async () => {
      const sql = fakeSql(({ sql: statement }) => {
        if (statement === REPORT_POLICIES_SQL) {
          return {
            rows: [
              {
                schemaname: "public",
                tablename: "tickets",
                policyname: "tickets_read",
                permissive: "PERMISSIVE",
                roles: ["authenticated"],
                cmd: "SELECT",
                qual: "(org_id IN ( SELECT permdock.permitted_organization_ids('ticket.read'::text) AS permitted_organization_ids))",
                with_check: null,
              },
              {
                schemaname: "public",
                tablename: "tickets",
                policyname: "own",
                permissive: "RESTRICTIVE",
                roles: ["authenticated"],
                cmd: "ALL",
                qual: "(owner_id = auth.uid())",
                with_check: null,
              },
              {
                schemaname: "stripe_sdp_acct_1",
                tablename: "charges",
                policyname: "stripe_sync",
                permissive: "PERMISSIVE",
                roles: ["stripe_sdp"],
                cmd: "ALL",
                qual: "true",
                with_check: null,
              },
            ],
          };
        }
        if (statement === NON_LEAKPROOF_INDEXED_SQL) {
          return {
            rows: [
              {
                schema: "public",
                table: "tickets",
                column: "status",
                type: "ticket_status",
              },
            ],
          };
        }
        return undefined;
      });
      const result = await runRlsReport({
        cwd: project({}),
        config: {},
        db: "postgres://local",
        connect: sql.connect,
      });
      expect(result.code).toBe(0);
      expect(sql.ended()).toBe(true);
      expect(result.data).toMatchObject({
        source: "database",
        tables: [
          {
            table: "public.tickets",
            helperCallsPerStatement: {
              select: 1,
              insert: 0,
              update: 0,
              delete: 0,
            },
            nonLeakproofIndexed: [{ column: "status", type: "ticket_status" }],
          },
        ],
        totals: { policies: 2, library: 0, provider: 1, app: 1 },
      });
      expect(result.output).toContain(
        "  index on status (ticket_status): = is not leakproof, so a filter on it does not use the index under RLS",
      );
      expect(result.output).toContain(
        "  tickets_read (select to authenticated, permissive, provider) calls permdock.permitted_organization_ids keys ticket.read",
      );
    });
  });

  describe("PD131", () => {
    const many = [
      `create policy a on public.docs for select to authenticated using (true);`,
      `create policy b on public.docs for select to public using (true);`,
      `create policy c on public.docs for all to authenticated using (true);`,
      `create policy d on public.docs for select to authenticated using ((select permdock.permdock_has('doc.read')));`,
      `create policy e on public.docs as restrictive for select to authenticated using (true);`,
      `create policy f on public.docs for select to anon using (true);`,
    ].join("\n");

    it("reports a command with more than doctor.policies.max policies for authenticated", async () => {
      const cwd = project({ [MIGRATION]: many });
      const findings = await pd131({ cwd, config: {} });
      expect(findings).toStrictEqual([
        {
          code: "PD131",
          severity: "warning",
          target: "public.docs:select",
          message:
            "public.docs has 5 select policies for authenticated, more than doctor.policies.max (4): a (permissive, app), b (permissive, app), c (permissive, app), d (permissive, provider), e (restrictive, app)",
          fix: "fold the provider or app policies into fewer conditions; permdock rls report lists the helper calls each one adds per statement",
        },
      ]);
      expect(
        await pd131({ cwd, config: { doctor: { policies: { max: 5 } } } }),
      ).toStrictEqual([]);
    });

    it("leaves the count to BS641 when better-supabase's doctor runs PermDock's", async () => {
      const cwd = project({
        [MIGRATION]: many,
        "better-supabase.config.mjs": `export default { authorization: { doctor: { command: ["permdock", "doctor", "--json"] } } };`,
      });
      expect(await pd131({ cwd, config: {} })).toStrictEqual([]);
    });
  });
});
