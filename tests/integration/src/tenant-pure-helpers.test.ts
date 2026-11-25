import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPermDock } from "permdock";
import { grantFingerprint } from "permdock/better-supabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { permissions, policy } from "../fixtures/tenant-pure/policy.ts";
import { run } from "./support/cli-run.ts";
import { rlsGenerate } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/tenant-pure");

const id = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Caller = {
  readonly id: string;
  readonly memberships: readonly (readonly [string, string])[];
};

const CALLERS = {
  // Grants doc.read in acme only.
  plain: { id: id(1), memberships: [["acme", "member"]] },
  // Grants doc.read in acme, plus in beta and delta, and is frozen in gamma.
  wide: {
    id: id(2),
    memberships: [
      ["acme", "editor"],
      ["beta", "member"],
      ["delta", "member"],
      ["gamma", "frozen"],
    ],
  },
  // Grants doc.read in acme and is frozen in gamma.
  frozenElsewhere: {
    id: id(3),
    memberships: [
      ["acme", "member"],
      ["gamma", "frozen"],
    ],
  },
  // Grants doc.read in acme through a reader role that adds nothing else.
  readerAndMember: {
    id: id(4),
    memberships: [
      ["acme", "member"],
      ["beta", "reader"],
    ],
  },
} as const satisfies Record<string, Caller>;

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select auth.jwt() ->> 'role'
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
`;

const seed = (): string =>
  [
    ...Object.values(CALLERS).map(
      (caller) => `insert into auth.users (id) values ('${caller.id}');`,
    ),
    ...Object.values(CALLERS).flatMap((caller) =>
      caller.memberships.map(
        ([tenant, role]) =>
          `insert into public.organization_members values ('${tenant}', '${caller.id}', '${role}');`,
      ),
    ),
  ].join("\n");

const instance = (caller: Caller) =>
  getPermDock(policy, {
    id: caller.id,
    kind: "user",
    tenant: "acme",
    memberships: caller.memberships.map(([tenant, role]) => ({
      scope: "tenant",
      id: tenant,
      roles: [role],
    })),
  });

describe("tenant-pure helpers", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-tenant-pure-"));
  let lite: PGlite | undefined;
  let manifest: {
    rls: {
      helpers: { name: string }[];
      tenantPureHelpers?: {
        name: string;
        keyArgument: string;
        tenantArgument: string;
      }[];
    };
  };

  beforeAll(async () => {
    const sql = join(dir, "rls.sql");
    const out = join(dir, "permdock.manifest.json");
    const generated = await rlsGenerate(["--target", "sql", "--out", sql], {
      cwd: FIXTURE,
    });
    if (generated.code !== 0) {
      throw new Error(`generate: ${generated.stdout}${generated.stderr}`);
    }
    const inspected = await run(["supabase", "inspect", "--out", out], {
      cwd: FIXTURE,
    });
    if (inspected.code !== 0) {
      throw new Error(`inspect: ${inspected.stdout}${inspected.stderr}`);
    }
    manifest = JSON.parse(readFileSync(out, "utf8"));
    lite = new PGlite();
    await lite.exec(SETUP);
    await lite.exec(readFileSync(sql, "utf8"));
    await lite.exec(seed());
  }, 120_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await lite?.close();
  });

  const ask = async (caller: Caller, expression: string): Promise<unknown> => {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    await lite.exec("begin");
    try {
      await lite.exec("set local role authenticated");
      await lite.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: caller.id, role: "authenticated" }),
      ]);
      return (
        await lite.query<{ ok: unknown }>(`select to_json(${expression}) as ok`)
      ).rows[0]?.ok;
    } finally {
      await lite.exec("rollback");
    }
  };

  const LISTED = {
    has: (key: string) => `permdock.permdock_tenant_has('${key}', 'acme')`,
    keys: (key: string) =>
      `permdock.permitted_tenant_permission_keys('acme', array['${key}'])`,
  };

  const idsByPermission = (key: string): string =>
    `(select coalesce(array_agg(t order by t), '{}') from permdock.permitted_tenant_ids_by_permission('${key}') t)`;

  it("lists the two helpers whose answer depends on one tenant and one key", () => {
    expect(manifest.rls.tenantPureHelpers).toStrictEqual([
      {
        name: "permdock.permdock_tenant_has",
        keyArgument: "p_grant",
        keyPosition: 0,
        tenantArgument: "p_tenant",
      },
      {
        name: "permdock.permitted_tenant_permission_keys",
        keyArgument: "p_keys",
        keyPosition: 1,
        tenantArgument: "p_id",
      },
    ]);
  });

  it("gives callers with an equal fingerprint the same answer from each listed helper", async () => {
    const { doc, file } = permissions;
    for (const permission of [doc.read, doc.update, file.read]) {
      const prints = await Promise.all(
        Object.values(CALLERS).map(async (caller) =>
          grantFingerprint(await instance(caller), [permission]),
        ),
      );
      const groups = new Map<string, Caller[]>();
      for (const [index, caller] of Object.values(CALLERS).entries()) {
        const print = prints[index];
        if (print === null || print === undefined) {
          continue;
        }
        groups.set(print, [...(groups.get(print) ?? []), caller]);
      }
      for (const callers of groups.values()) {
        for (const helper of Object.values(LISTED)) {
          const answers = await Promise.all(
            callers.map((caller) => ask(caller, helper(permission.key))),
          );
          expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
        }
      }
    }
  });

  it("finds at least one pair with an equal fingerprint for doc.read", async () => {
    const prints = await Promise.all(
      [CALLERS.plain, CALLERS.wide, CALLERS.frozenElsewhere].map(
        async (caller) =>
          grantFingerprint(await instance(caller), [permissions.doc.read]),
      ),
    );
    expect(prints[0]).toMatch(/^gf1:/u);
    expect(prints[1]).toBe(prints[0]);
  });

  it("shows permitted_tenant_ids_by_permission answering differently for an equal fingerprint", async () => {
    const key = permissions.doc.read.key;
    const [plain, wide] = await Promise.all([
      instance(CALLERS.plain),
      instance(CALLERS.wide),
    ]);
    expect(grantFingerprint(wide, [permissions.doc.read])).toBe(
      grantFingerprint(plain, [permissions.doc.read]),
    );
    expect(await ask(CALLERS.plain, idsByPermission(key))).toStrictEqual([
      "acme",
    ]);
    expect(await ask(CALLERS.wide, idsByPermission(key))).toStrictEqual([
      "acme",
      "beta",
      "delta",
    ]);
  });
});
