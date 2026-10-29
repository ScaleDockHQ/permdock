import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { SqlClient } from "../../src/cli/pg.ts";
import type { PermDockConfig } from "../../src/cli/types.ts";

import { runDoctor } from "../../src/cli/doctor/doctor.ts";
import { supabaseHookSql } from "../../src/cli/supabase-hook/supabase-hook.ts";
import { tableMembershipSource } from "../../src/supabase/index.ts";

const scopes = [{ name: "organization", key: "organization_id" }];
const memberships = [tableMembershipSource({ table: "memberships" })];
const io = { stdout: () => undefined, stderr: () => undefined };
const NOW = new Date("2026-10-29T12:00:00Z");

const temps: string[] = [];

function hookOf(security?: "invoker" | "definer"): string {
  return supabaseHookSql(scopes, {
    policy: "p.ts",
    supabase: {
      hook:
        security === undefined ? { memberships } : { memberships, security },
    },
  }).sql;
}

describe("supabase.hook.security", () => {
  it("runs the hook as invoker by default, with a read policy per table", () => {
    const sql = hookOf();
    expect(sql).toContain(
      `custom_access_token_hook(event jsonb)\nreturns jsonb\nlanguage plpgsql\nstable\nset search_path = ''`,
    );
    expect(sql).toContain(
      `grant select on table "public"."memberships" to supabase_auth_admin;`,
    );
  });

  it("emits a definer hook that grants supabase_auth_admin execute only", () => {
    const sql = hookOf("definer");
    expect(sql).toContain(
      `custom_access_token_hook(event jsonb)\nreturns jsonb\nlanguage plpgsql\nstable\nsecurity definer\nset search_path = ''`,
    );
    expect(sql).toContain(
      `revoke execute on function "permdock".custom_access_token_hook(jsonb) from authenticated, anon, public;\ngrant usage on schema "permdock" to supabase_auth_admin;\ngrant execute on function "permdock".custom_access_token_hook(jsonb) to supabase_auth_admin;`,
    );
    expect(sql).not.toMatch(/grant select on .* to supabase_auth_admin/u);
    expect(sql).not.toContain("service_role");
  });
});

type Call = { readonly sql: string; readonly values: unknown[] };

function fakeDb(fail?: string): {
  readonly calls: Call[];
  readonly connect: () => Promise<SqlClient>;
} {
  const calls: Call[] = [];
  return {
    calls,
    connect: () =>
      Promise.resolve({
        query: (sql, values) => {
          calls.push({ sql, values });
          if (fail !== undefined && sql.startsWith("select")) {
            return Promise.reject(new Error(fail));
          }
          return Promise.resolve({ rows: [] });
        },
        end: () => Promise.resolve(),
      }),
  };
}

function project(claims?: unknown): { cwd: string; config: PermDockConfig } {
  const cwd = mkdtempSync(join(tmpdir(), "permdock-pd085-"));
  temps.push(cwd);
  if (claims !== undefined) {
    writeFileSync(join(cwd, "claims.json"), JSON.stringify(claims));
  }
  return {
    cwd,
    config: {
      supabase: { hook: { memberships } },
      ...(claims === undefined ? {} : { doctor: { claims: "claims.json" } }),
    },
  };
}

async function doctor(
  target: { cwd: string; config: PermDockConfig },
  db: ReturnType<typeof fakeDb> | undefined,
) {
  return runDoctor({
    ...target,
    only: ["pd085"],
    json: false,
    fix: false,
    strict: false,
    color: false,
    now: NOW,
    io,
    ...(db === undefined ? {} : { db: "postgres://test", connect: db.connect }),
  });
}

describe("PD085", () => {
  afterAll(() => {
    for (const dir of temps) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs nothing without --db-url-stdin", async () => {
    const result = await doctor(project(), undefined);
    expect(result.findings).toStrictEqual([]);
  });

  it("calls the hook as supabase_auth_admin in a rolled-back transaction, once per sample", async () => {
    const db = fakeDb();
    const result = await doctor(
      project([{ sub: "4b1d8a52-1f2c-4e5a-9b77-0e6f1c2d3a4b" }, { iss: "x" }]),
      db,
    );
    expect(result.code).toBe(0);
    expect(db.calls.map((call) => call.sql)).toStrictEqual([
      "begin",
      "set local role supabase_auth_admin",
      `select "permdock".custom_access_token_hook($1::jsonb) as event`,
      "rollback",
      "begin",
      "set local role supabase_auth_admin",
      `select "permdock".custom_access_token_hook($1::jsonb) as event`,
      "rollback",
    ]);
    expect(JSON.parse(String(db.calls[6]?.values[0]))).toMatchObject({
      user_id: "4b1d8a52-1f2c-4e5a-9b77-0e6f1c2d3a4b",
    });
  });

  it("reports the error the hook raises as supabase_auth_admin", async () => {
    const result = await doctor(
      project(),
      fakeDb("permission denied for table memberships"),
    );
    expect(result.code).toBe(1);
    expect(result.findings).toMatchObject([
      {
        code: "PD085",
        severity: "error",
        message: expect.stringContaining(
          "permission denied for table memberships",
        ),
      },
    ]);
  });
});
