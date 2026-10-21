import type { Principal } from "permdock";
import type { RlsParityFixture, RlsQueryFn } from "permdock/testing";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedRows, testRlsParity } from "permdock/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { permissions, policy } from "../fixtures/sentinel-scopes/policy.ts";
import { startPostgres } from "./support/postgres.ts";
import { generateRls } from "./support/rls.ts";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/sentinel-scopes",
);

const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated to tester;
grant usage on schema public to authenticated, anon;
create table zorg_people (zorg_id text not null, user_id text not null, role text not null);
create table zcust_people (zcust_id text not null, zorg_id text not null, user_id text not null, role text not null);
create table widget (id text primary key, zorg_id text not null, zcust_id text not null);
grant select, insert, update, delete on widget to authenticated;
`;

const widgets = [
  { id: "w_a1", zorg_id: "A", zcust_id: "a1" },
  { id: "w_a2", zorg_id: "A", zcust_id: "a2" },
  { id: "w_b1", zorg_id: "B", zcust_id: "b1" },
] as const;

const people: Readonly<Record<string, Principal>> = {
  admin: {
    id: "u_admin",
    tenant: "A",
    memberships: [{ scope: "zorg", id: "A", roles: ["admin"] }],
  },
  viewer: {
    id: "u_viewer",
    tenant: "A",
    memberships: [{ scope: "zorg", id: "A", roles: ["viewer"] }],
  },
  contact: {
    id: "u_contact",
    tenant: "A",
    memberships: [
      { scope: "zcust", id: "a1", within: { zorg: "A" }, roles: ["contact"] },
    ],
  },
};

/**
 * Comments, and the SQL contract names that stay whatever the scopes are
 * called.
 */
const CONTRACT = /--[^\n]*|app\.tenant_id|p_tenant/gu;

describe("generated RLS with sentinel scope names", () => {
  let db: Postgres | undefined;
  let generated = "";

  const admin: RlsQueryFn = async (sql, values) => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const result = await db.admin.query(
      sql,
      values === undefined ? undefined : [...values],
    );
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  };

  const query: RlsQueryFn = async (sql, values) => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    try {
      const result = await db.tester.query(
        sql,
        values === undefined ? undefined : [...values],
      );
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "42501"
      ) {
        return { rows: [], rowCount: 0, code: "42501" };
      }
      throw error;
    }
  };

  beforeAll(async () => {
    generated = await generateRls(FIXTURE, ["--dialect", "guc"]);
    db = await startPostgres([SETUP, generated]);
    await seedRows(admin, {
      zorg_people: [
        { zorg_id: "A", user_id: "u_admin", role: "admin" },
        { zorg_id: "A", user_id: "u_viewer", role: "viewer" },
      ],
      zcust_people: [
        { zcust_id: "a1", zorg_id: "A", user_id: "u_contact", role: "contact" },
      ],
      widget: widgets,
    });
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("names every helper, table and column after the declared scopes", () => {
    expect(generated).toContain("permitted_zorg_ids(p_grant text)");
    expect(generated).toContain("permitted_zcust_ids(p_grant text)");
    expect(generated.replaceAll(CONTRACT, "")).not.toMatch(
      /tenant|organization|\bteam/iu,
    );
  });

  it("agrees with decide and the snapshot for every person, permission and row", async () => {
    const fixtures: RlsParityFixture[] = Object.entries(people).flatMap(
      ([name, subject]) =>
        [permissions.widget.read, permissions.widget.update].flatMap(
          (permission) =>
            widgets.map((row) => ({
              name: `${name} ${permission.key} ${row.id}`,
              subject: {
                id: subject.id,
                roles: [],
                memberships: subject.memberships ?? [],
                tenant: "A",
              },
              permission,
              row,
              table: "widget",
            })),
        ),
    );
    const report = await testRlsParity(policy, {
      dialect: "guc",
      fixtures,
      query,
      snapshot: true,
    });
    expect(report.results.filter((item) => !item.ok)).toStrictEqual([]);
    expect(
      report.results.filter((item) => item.granted).map((item) => item.name),
    ).toStrictEqual([
      "admin widget.read w_a1",
      "admin widget.read w_a2",
      "admin widget.update w_a1",
      "admin widget.update w_a2",
      "viewer widget.read w_a1",
      "viewer widget.read w_a2",
      "contact widget.read w_a1",
    ]);
  });
});
