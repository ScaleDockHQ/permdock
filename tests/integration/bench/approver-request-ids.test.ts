import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rlsGenerate } from "../src/support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/approver-set");

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const ADMIN = id(1);
const MEMBER = id(2);
const DELEGATE = id(3);
const PLATFORM = id(4);
const NOBODY = id(5);
const USERS = { ADMIN, MEMBER, DELEGATE, PLATFORM, NOBODY };
const STAFF = 60;
const REQUESTS = 147;
const RUNS = 7;

const ORG_A = id(0xb1);
const ORG_B = id(0xb2);

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
create schema auth;
create table auth.users (id uuid primary key, raw_app_meta_data jsonb not null default '{}');
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create table organizations (id uuid primary key, slug text not null, disabled_at timestamptz);
create table profiles (user_id uuid primary key, active_organization_id uuid, disabled_at timestamptz);
create table memberships (
  user_id uuid not null, scope text not null, scope_id uuid not null, role text not null,
  via text, expires_at timestamptz
);
create table contacts (
  id uuid primary key, organization_id uuid not null, customer_id uuid not null, user_id uuid, name text
);
create table customers (id uuid primary key, organization_id uuid not null);
create table quotes (id uuid primary key, organization_id uuid not null, customer_id uuid not null);
create table reporting_lines (user_id uuid not null, manager_id uuid, organization_id uuid not null);
`;

/**
 * An admin of A (a member of B), two members of A, a platform admin and a user
 * with no membership; staff 6 to 60 report to the member or the one before
 * them; the admin covers for the delegate everywhere, and the member covers for
 * the user with no membership in A for expenses only.
 */
const SEED = `
insert into auth.users select ('00000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid from generate_series(1, ${STAFF}) n;
insert into profiles (user_id) select id from auth.users;
insert into organizations values ('${ORG_A}', 'a', null), ('${ORG_B}', 'b', null);
insert into memberships values
  ('${ADMIN}', 'organization', '${ORG_A}', 'admin', 'staff', null),
  ('${ADMIN}', 'organization', '${ORG_B}', 'member', 'staff', null),
  ('${MEMBER}', 'organization', '${ORG_A}', 'member', 'staff', null),
  ('${DELEGATE}', 'organization', '${ORG_A}', 'member', 'staff', null);
insert into memberships
  select ('00000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, 'organization',
    case when n % 7 = 0 then '${ORG_B}'::uuid else '${ORG_A}'::uuid end, 'member', 'staff', null
  from generate_series(6, ${STAFF}) n;
insert into permdock.user_roles values ('${PLATFORM}', 'platform-admin');
insert into reporting_lines values ('${MEMBER}', '${ADMIN}', '${ORG_A}');
insert into reporting_lines
  select ('00000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
    case when n % 3 = 0 then '${MEMBER}'::uuid
      else ('00000000-0000-4000-8000-' || lpad(to_hex(greatest(n - 1, 6)), 12, '0'))::uuid end,
    '${ORG_A}'
  from generate_series(7, ${STAFF}) n;
insert into permdock.approval_delegations (delegator, delegate, tenant, resources, "from", "until") values
  ('${ADMIN}', '${DELEGATE}', null, null, now() - interval '1 day', now() + interval '1 day'),
  ('${MEMBER}', '${NOBODY}', '${ORG_A}', array['expense'], now() - interval '1 day', now() + interval '1 day'),
  ('${MEMBER}', '${DELEGATE}', null, null, now() - interval '2 days', now() - interval '1 day');
create table requests (n integer primary key, id text not null, kind text, tenant uuid, requester uuid, approvers jsonb);
`;

const KINDS = [
  "expense.submit",
  "expense.submit",
  "expense.submit",
  "job.update",
  "quote.send",
  "invoice",
  ".odd",
  null,
];

const STEPS = [
  { manager: true, permission: "customers.update", required: 1 },
  { users: [MEMBER], required: 1 },
  { permission: "quotes.update" },
  null,
  { manager: true, required: 1 },
  { permission: "organizations.update", users: "not a list" },
];

function requestRows(): string {
  const rows: string[] = [];
  for (let n = 0; n < REQUESTS; n += 1) {
    const kind = KINDS[n % KINDS.length];
    const tenant =
      n % 11 === 0 ? "null" : n % 5 === 0 ? `'${ORG_B}'` : `'${ORG_A}'`;
    const requester = n % 13 === 0 ? ADMIN : id(6 + (n % 55));
    const step = STEPS[n % STEPS.length];
    rows.push(
      `(${String(n)}, 'r${String(n)}', ${kind === null ? "null" : `'${kind}'`}, ${tenant}, '${requester}', ${step === null ? "null" : `'${JSON.stringify(step)}'::jsonb`})`,
    );
  }
  return `insert into requests values ${rows.join(",\n")};\nanalyze;`;
}

/** better-supabase's kind map: the provider's `approvers` option. */
const KIND_APPROVERS: Readonly<Record<string, unknown>> = {
  "job.update": { kind: "permission", permission: "organizations.update" },
  "quote.send": {
    kind: "any-of",
    of: [
      { kind: "manager", levels: 2 },
      { kind: "user", id: id(9) },
    ],
  },
  invoice: [
    { kind: "permission", permission: "customers.read" },
    { kind: "manager" },
  ],
  ".odd": { kind: "user", id: ADMIN },
};

const json = (value: unknown) =>
  `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;

function resourceOf(kind: string): string {
  const dot = kind.indexOf(".");
  return dot <= 0 ? kind : kind.slice(0, dot);
}

/** The provider's `isApprover` template, filled per request row `r`. */
function perRequest(
  kinds: Readonly<Record<string, unknown>>,
  current: boolean,
) {
  const passed = current ? ", r.approvers" : "";
  const branches = Object.entries(kinds).map(
    ([kind, approvers]) =>
      `when '${kind}' then permdock.permdock_is_approver(${json(approvers)}, (r.tenant)::text, (r.requester)::text, '${resourceOf(kind)}'${passed})`,
  );
  const otherwise = current
    ? `permdock.permdock_is_approver(null::jsonb, (r.tenant)::text, (r.requester)::text, split_part(r.kind, '.', 1)${passed})`
    : "false";
  const check =
    branches.length === 0
      ? otherwise
      : `case r.kind ${branches.join(" ")} else ${otherwise} end`;
  return (limit: number) =>
    `select r.id from (select * from requests order by n limit ${String(limit)}) r where coalesce(${check}, false) order by r.n`;
}

/** The same decision, with every request passed to the set form at once. */
function asSet(kinds: Readonly<Record<string, unknown>>, current: boolean) {
  return (limit: number) => `select r.id
from (select * from requests order by n limit ${String(limit)}) r
where r.id in (select permdock.permdock_approver_request_ids(
  (select jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.kind, 'tenant', x.tenant, 'requester', x.requester, 'approvers', x.approvers))
    from (select * from requests order by n limit ${String(limit)}) x),
  ${json(kinds)},
  ${String(current)}
))
order by r.n`;
}

const SHAPES = [
  ["CentraKit: requestApprovers only", {}, true],
  ["approvers by kind with requestApprovers", KIND_APPROVERS, true],
  ["approvers by kind", KIND_APPROVERS, false],
] as const;

describe("permdock_approver_request_ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-approver-set-"));
  let lite: PGlite | undefined;

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const result = await rlsGenerate(
      ["--target", "sql", "--rbac", "supabase", "--out", out],
      { cwd: FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    lite = new PGlite();
    await lite.exec(SETUP);
    await lite.exec(readFileSync(out, "utf8"));
    await lite.exec(SEED);
    await lite.exec(requestRows());
  }, 120_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await lite?.close();
  });

  async function best(
    user: string,
    sql: string,
  ): Promise<{ ms: number; ids: string[] }> {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    await lite.query("select set_config('request.jwt.claims', $1, false)", [
      JSON.stringify({ sub: user, role: "authenticated" }),
    ]);
    let ms = Number.POSITIVE_INFINITY;
    let ids: string[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const start = performance.now();
      const result = await lite.query<{ id: string }>(sql);
      ms = Math.min(ms, performance.now() - start);
      ids = result.rows.map((row) => row.id);
    }
    return { ms, ids };
  }

  for (const [label, kinds, current] of SHAPES) {
    it(`answers as permdock_is_approver per request for every user (${label})`, async () => {
      const decided: Record<string, number> = {};
      for (const [name, user] of Object.entries(USERS)) {
        const reference = await best(
          user,
          perRequest(kinds, current)(REQUESTS),
        );
        const set = await best(user, asSet(kinds, current)(REQUESTS));
        expect({ name, ids: set.ids }).toStrictEqual({
          name,
          ids: reference.ids,
        });
        decided[name] = set.ids.length;
      }
      expect(decided["NOBODY"]).toBe(0);
      expect(
        Object.values(decided).filter((count) => count > 0).length,
      ).toBeGreaterThanOrEqual(3);
    });
  }

  it("refuses everything without a signed-in user or with no requests", async () => {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    await lite.query("select set_config('request.jwt.claims', '', false)");
    const anonymous = await lite.query(
      `select * from permdock.permdock_approver_request_ids(${json([{ id: "r", kind: ".odd", tenant: null }])}, ${json(KIND_APPROVERS)}, true)`,
    );
    expect(anonymous.rows).toHaveLength(0);
    const empty = await best(
      ADMIN,
      "select * from permdock.permdock_approver_request_ids('[]'::jsonb, '{}'::jsonb, true) as t(id)",
    );
    expect(empty.ids).toHaveLength(0);
    const scalar = await best(
      ADMIN,
      `select * from permdock.permdock_approver_request_ids('{"id": "r"}'::jsonb, ${json(KIND_APPROVERS)}) as t(id)`,
    );
    expect(scalar.ids).toHaveLength(0);
  });

  it(`is faster for ${String(REQUESTS)} requests and costs about the same for one`, async () => {
    const [, kinds, current] = SHAPES[0];
    for (const user of Object.values(USERS)) {
      const many = {
        set: await best(user, asSet(kinds, current)(REQUESTS)),
        reference: await best(user, perRequest(kinds, current)(REQUESTS)),
      };
      const one = {
        set: await best(user, asSet(kinds, current)(1)),
        reference: await best(user, perRequest(kinds, current)(1)),
      };
      expect(many.set.ms).toBeLessThan(many.reference.ms / 2);
      expect(one.set.ms).toBeLessThan(one.reference.ms * 1.5 + 0.5);
    }
  });
});
