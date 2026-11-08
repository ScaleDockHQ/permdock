import { PGlite } from "@electric-sql/pglite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  OWNER,
  PRIVATE,
  SETUP,
  STAFF,
  USERS,
  VIEWER,
} from "./support/named-scopes-schema.ts";
import { rlsAndHook } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/named-scopes/disabled");

/**
 * The generated helpers before the shared role join: each body joined
 * `role_permissions` itself and filtered `scope` in its `where`. The lateral
 * call of `permdock_role_grant_keys(scope, role)` is rewritten to that join, so
 * the two SQL files differ only in the role join.
 */
const LATERAL =
  /cross join lateral ("?[\w]+"?)\."?permdock_role_grant_keys"?\('(\w+)', ([^()\n]*?)\) rp\(grant_key\)/gu;

function legacy(sql: string): string {
  return sql.replaceAll(
    LATERAL,
    (_all, schema: string, scope: string, role: string) =>
      `join (select rp0.role, rp0.grant_key from ${schema}.role_permissions rp0 where rp0.scope = '${scope}') rp on rp.role = ${role}`,
  );
}

type Claims = Record<string, unknown>;

const MODES = [
  { mode: "jwt", cwd: FIXTURE },
  { mode: "database", cwd: join(FIXTURE, "database") },
  { mode: "database over sources", cwd: join(FIXTURE, "sources") },
  { mode: "database over sources, keep", cwd: join(FIXTURE, "sources-keep") },
] as const;

describe.each(MODES)("role join, old and new SQL ($mode)", ({ cwd, mode }) => {
  let current: PGlite | undefined;
  let before: PGlite | undefined;
  let helpers: readonly string[] = [];
  let grants: readonly string[] = [];
  let rewritten = false;

  async function load(sqls: readonly string[]): Promise<PGlite> {
    const lite = new PGlite();
    await lite.exec(SETUP);
    for (const sql of sqls) {
      await lite.exec(sql);
    }
    return lite;
  }

  beforeAll(async () => {
    const generated = await rlsAndHook(cwd);
    const [rls = "", ...rest] = generated;
    const old = legacy(rls);
    rewritten =
      rls.includes("cross join lateral") &&
      /lateral[^\n]*permdock_role_grant_keys/u.test(rls) &&
      !/lateral[^\n]*permdock_role_grant_keys/u.test(old) &&
      /join \(select rp0\.role/u.test(old);
    current = await load(generated);
    before = await load([old, ...rest]);
    helpers = [
      ...rls.matchAll(
        /create or replace function "permdock"\.(permitted_\w+_ids)\(p_grant text\)/gu,
      ),
    ].map((match) => match[1] ?? "");
    const keys = await current.query<{ grant_key: string }>(
      "select distinct grant_key from permdock.role_permissions order by 1",
    );
    grants = [...keys.rows.map((row) => row.grant_key), "no.such.key"];
  });

  afterAll(async () => {
    await current?.close();
    await before?.close();
  });

  async function claimsFor(
    lite: PGlite,
    user: string,
    tenant: string,
  ): Promise<Claims> {
    if (mode !== "jwt") {
      return {
        sub: user,
        role: "authenticated",
        aal: "aal1",
        tenant_id: tenant,
      };
    }
    await lite.exec("begin; set local role supabase_auth_admin;");
    try {
      await lite.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ role: "supabase_auth_admin" }),
      ]);
      const result = await lite.query<{ event: { claims: Claims } }>(
        "select permdock.custom_access_token_hook($1::jsonb) as event",
        [
          JSON.stringify({
            user_id: user,
            claims: { sub: user, role: "authenticated", aal: "aal1" },
          }),
        ],
      );
      return { ...result.rows[0]?.event.claims, tenant_id: tenant };
    } finally {
      await lite.exec("rollback");
    }
  }

  async function decide(
    lite: PGlite,
    user: string,
    tenant: string,
  ): Promise<Record<string, string[] | boolean>> {
    const claims = await claimsFor(lite, user, tenant);
    await lite.exec("begin; set local role authenticated;");
    try {
      await lite.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify(claims),
      ]);
      const out: Record<string, string[] | boolean> = {};
      for (const grant of grants) {
        const has = await lite.query<{ has: boolean }>(
          "select permdock.permdock_has($1) as has",
          [grant],
        );
        out[`has ${grant}`] = has.rows[0]?.has ?? false;
        for (const helper of helpers) {
          const ids = await lite.query<{ id: string }>(
            `select id::text from permdock.${helper}($1) as id order by 1`,
            [grant],
          );
          out[`${helper} ${grant}`] = ids.rows.map((row) => row.id);
        }
      }
      return out;
    } finally {
      await lite.exec("rollback");
    }
  }

  it("rewrites the lateral calls it compares", () => {
    expect(rewritten).toBe(true);
    expect(helpers.length).toBeGreaterThan(0);
    expect(grants.length).toBeGreaterThan(1);
  });

  it.each(USERS)("decides alike for user %s in every tenant", async (user) => {
    const known = [OWNER, STAFF, PRIVATE, VIEWER];
    expect(known).toContain(user);
    for (const tenant of ["T", "B", "none"]) {
      if (current === undefined || before === undefined) {
        throw new Error("PermDock: PGlite did not start");
      }
      const next = await decide(current, user, tenant);
      const old = await decide(before, user, tenant);
      expect(next).toStrictEqual(old);
    }
  });

  it("grants something to at least one user, so the comparison is not empty", async () => {
    if (current === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    let granted = 0;
    for (const user of USERS) {
      for (const tenant of ["T", "B"]) {
        const decided = await decide(current, user, tenant);
        granted += Object.values(decided).filter(
          (value) =>
            value === true || (Array.isArray(value) && value.length > 0),
        ).length;
      }
    }
    expect(granted).toBeGreaterThan(0);
  });
});
