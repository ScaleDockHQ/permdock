import type { Membership, Permission, Principal } from "permdock";
import type { RlsParityFixture, RlsQueryFn } from "permdock/testing";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { rlsParity } from "permdock/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import {
  assets,
  documents,
  permissions,
  personas,
  policy,
} from "../fixtures/named-scopes/policy.ts";
import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/named-scopes/suspended");

const values = (rows: readonly Record<string, string>[], keys: string[]) =>
  rows
    .map((row) => `(${keys.map((key) => `'${row[key] ?? ""}'`).join(", ")})`)
    .join(", ");

// Organization B is disabled, customer G is archived, and the platform admin's profile is disabled.
const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated to tester;
grant usage on schema public to authenticated, anon;
create table organization_users (organization_id text not null, user_id text not null, role text not null, via text);
create table customer_contacts (
  customer_id text not null, organization_id text not null, user_id text not null, role text not null, via text
);
insert into organization_users values
  ('T', 'u_owner', 'owner', 'staff'), ('B', 'u_owner', 'owner', 'staff'),
  ('B', 'u_viewer', 'viewer', 'staff'), ('T', 'u_staff_contact', 'member', 'staff');
insert into customer_contacts values
  ('A', 'T', 'u_private', 'contact', 'contact'), ('G', 'T', 'u_business', 'contact', 'contact'),
  ('C', 'B', 'u_staff_contact', 'contact', 'contact');
create table organization (id text primary key, disabled_at timestamptz);
insert into organization values ('T', null), ('B', now());
create table customer (id text primary key, status text);
insert into customer values ('A', 'active'), ('G', 'archived'), ('C', 'active'), ('D', 'prospect');
create table profiles (id text primary key, disabled_at timestamptz);
insert into profiles values
  ('u_owner', null), ('u_viewer', null), ('u_private', null), ('u_business', null),
  ('u_staff_contact', null), ('u_platform_support', null), ('u_platform_admin', now());
create table quote (id text primary key, organization_id text not null, customer_id text not null, status text not null);
create table invoice (id text primary key, organization_id text not null, customer_id text not null, status text not null);
create table asset (id text primary key, organization_id text not null, customer_id text not null);
insert into quote values ${values(documents, ["id", "organization_id", "customer_id", "status"])};
insert into invoice values ${values(documents, ["id", "organization_id", "customer_id", "status"])};
insert into asset values ${values(assets, ["id", "organization_id", "customer_id"])};
grant select, insert, update, delete on quote, invoice, asset to authenticated;
`;

type Subject = RlsParityFixture["subject"];

const SUSPENDED_ORGS = new Set(["B"]);
const SUSPENDED_CUSTOMERS = new Set(["G"]);
const SUSPENDED_USERS = new Set(["u_platform_admin"]);

/** What a membership source that honours suspension returns for the persona. */
function active(membership: Membership): boolean {
  const organization =
    membership.scope === "organization"
      ? membership.id
      : membership.within?.["organization"];
  if (organization !== undefined && SUSPENDED_ORGS.has(organization)) {
    return false;
  }
  return !(
    membership.scope === "customer" &&
    membership.id !== undefined &&
    SUSPENDED_CUSTOMERS.has(membership.id)
  );
}

function subjectOf(principal: Principal, tenant?: string): Subject {
  const current = tenant ?? principal.tenant;
  const suspended = SUSPENDED_USERS.has(principal.id);
  return {
    id: principal.id,
    roles: suspended ? [] : (principal.roles ?? []),
    memberships: suspended ? [] : (principal.memberships ?? []).filter(active),
    ...(current === undefined ? {} : { tenant: current }),
  };
}

const subjects: Readonly<Record<string, Subject>> = {
  owner: subjectOf(personas.owner),
  ownerInB: subjectOf(personas.owner, "B"),
  viewer: subjectOf(personas.viewer),
  privateContact: subjectOf(personas.privateContact),
  businessContact: subjectOf(personas.businessContact),
  staffContact: subjectOf(personas.staffContact),
  staffContactInB: subjectOf(personas.staffContact, "B"),
  platformAdmin: subjectOf(personas.platformAdmin),
};

const leaves: readonly (readonly [Permission, string])[] = [
  [permissions.quote.read, "quote"],
  [permissions.quote.update, "quote"],
  [permissions.invoice.read, "invoice"],
  [permissions.asset.read, "asset"],
  [permissions.asset.delete, "asset"],
];

const fixtures: readonly RlsParityFixture[] = Object.entries(subjects).flatMap(
  ([name, subject]) =>
    leaves.flatMap(([permission, table]) =>
      (table === "asset" ? assets : documents).map((row) => ({
        name: `${name} ${permission.key} ${row.id}`,
        subject,
        permission,
        row,
        table,
      })),
    ),
);

async function generate(cwd: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "permdock-suspension-"));
  const out = join(dir, "rls.sql");
  const result = await run(
    ["rls", "generate", "--target", "sql", "--dialect", "guc", "--out", out],
    { cwd },
  );
  if (result.code !== 0) {
    throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
  }
  const sql = readFileSync(out, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return sql;
}

const USER_ROLES = `insert into permdock.user_roles values
  ('u_platform_admin', 'platform-admin'), ('u_platform_support', 'platform-support')`;

describe.each([
  { mode: "database", cwd: FIXTURE },
  { mode: "jwt", cwd: join(FIXTURE, "jwt") },
])("suspension in generated RLS ($mode mode)", ({ mode, cwd }) => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    db = await startPostgres([
      SETUP,
      await generate(cwd),
      ...(mode === "database" ? [USER_ROLES] : []),
    ]);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  const query: RlsQueryFn = async (sql, params) => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    try {
      const result = await db.tester.query(
        sql,
        params === undefined ? undefined : [...params],
      );
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    } catch (error) {
      const code =
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : undefined;
      if (code === "42501") {
        return { rows: [], rowCount: 0, code };
      }
      throw error;
    }
  };

  function helper(
    principal: Principal,
    tenant: string,
    sql: string,
    params: readonly unknown[],
  ): Promise<string[]> {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const client = db.tester;
    return db.as(
      {
        role: "authenticated",
        settings: {
          "app.user_id": principal.id,
          "app.user_role": (principal.roles ?? []).join(","),
          "app.tenant_id": tenant,
          // The unfiltered memberships: a token minted before the suspension.
          "app.memberships": JSON.stringify(principal.memberships ?? []),
        },
      },
      async () =>
        (await client.query<{ readonly v: string }>(sql, [...params])).rows.map(
          (row) => row.v,
        ),
    );
  }

  it("agrees with decide over the memberships a suspension-aware source returns", async () => {
    const report = await rlsParity(policy, {
      dialect: "guc",
      fixtures,
      query,
      snapshot: true,
    });
    expect(report.results.filter((item) => !item.ok)).toEqual([]);
    const allowed = (name: string): string[] =>
      report.results
        .filter((item) => item.name.startsWith(`${name} `) && item.granted)
        .map((item) => item.name.slice(name.length + 1));
    expect(allowed("privateContact")).toContain("quote.read d_a_sent");
    expect(allowed("owner")).toContain("asset.delete a_g_sent");
    expect(allowed("ownerInB")).toEqual([]);
    expect(allowed("viewer")).toEqual([]);
    expect(allowed("businessContact")).toEqual([]);
    expect(allowed("staffContactInB")).toEqual([]);
  });

  it("drops a suspended instance even when the memberships still name it", async () => {
    const keysOf = async (scope: string): Promise<string[]> =>
      (
        await db!.admin.query<{ readonly v: string }>(
          `select distinct grant_key as v from permdock.role_permissions where permission = 'quote.read' and scope = $1`,
          [scope],
        )
      ).rows.map((row) => row.v);
    const organizationKeys = await keysOf("organization");
    const organizations = (principal: Principal, tenant: string) =>
      helper(
        principal,
        tenant,
        `select distinct v from unnest($1::text[]) k, permdock.permitted_organization_ids(k) v`,
        [organizationKeys],
      );
    expect(await organizations(personas.owner, "T")).toEqual(["T"]);
    expect(await organizations(personas.owner, "B")).toEqual([]);
    expect(await organizations(personas.viewer, "B")).toEqual([]);
    const keys = await keysOf("customer");
    const customers = await helper(
      personas.businessContact,
      "T",
      `select distinct v from unnest($1::text[]) k, permdock.permitted_customer_ids(k) v`,
      [keys],
    );
    expect(customers).toEqual([]);
  });

  it("takes no global roles from a suspended user", async () => {
    const has = (principal: Principal) =>
      helper(
        principal,
        "",
        `select permdock.permdock_has('organization.read')::text as v`,
        [],
      );
    expect(await has(personas.platformSupport)).toEqual(["true"]);
    expect(await has(personas.platformAdmin)).toEqual(["false"]);
  });
});
