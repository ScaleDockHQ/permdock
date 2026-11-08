import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";

import { runPolicyBundle } from "../../src/cli/policy-bundle.ts";
import { helpersSql } from "../../src/cli/rls/helpers.ts";
import {
  bundleLoaderSql,
  bundleDigest,
  policyBundle,
} from "../../src/cli/sql/policy-bundle.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  resource,
  role,
} from "../../src/index.ts";

const Row = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
} as const;

const permissions = definePermissions({
  doc: resource(Row, {
    id: "id",
    actions: ["read", "update"],
    relations: { org: { field: "org_id", memberOf: "org" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { org: { key: "org_id" } },
  // SAFETY: the bundle never calls the subject mapper.
  subject: (user: unknown) => user as never,
  roles: [
    role(
      "admin",
      [allow(permissions.doc.read), allow(permissions.doc.update)],
      { on: "org" },
    ),
    role(
      "editor",
      [allow(permissions.doc.read), deny(permissions.doc.update)],
      { on: "org" },
    ),
  ],
});

const rows = [
  {
    role: "b",
    permission: "doc.read",
    grantKey: "doc.read",
    scope: "org",
    effect: "allow",
  },
  {
    role: "a",
    permission: "doc.read",
    grantKey: "doc.read",
    scope: "org",
    effect: "allow",
  },
  {
    role: "a",
    permission: "doc.read",
    grantKey: "doc.read",
    scope: "org",
    effect: "allow",
  },
] as const;

function ctx(extra: Partial<RlsSqlContext> = {}): RlsSqlContext {
  return {
    dialect: "supabase",
    scopes: [{ name: "org", key: "org_id" }],
    tenantClaim: "tenant_id",
    gucPrefix: "app",
    authorize: "database",
    memberships: {
      scopes: {
        org: { table: "m", user: "u", role: "r", columns: { org: "o" } },
      },
    },
    ...extra,
  };
}

describe("policy bundle", () => {
  it("is the same bytes for the same rows in any order, once per row", () => {
    const forward = policyBundle(rows);
    const backward = policyBundle([...rows].toReversed());
    expect(backward).toStrictEqual(forward);
    expect(JSON.parse(forward.text)).toStrictEqual({
      format: "policy-bundle",
      v: 1,
      rows: [
        {
          effect: "allow",
          grant_key: "doc.read",
          permission: "doc.read",
          role: "a",
          scope: "org",
        },
        {
          effect: "allow",
          grant_key: "doc.read",
          permission: "doc.read",
          role: "b",
          scope: "org",
        },
      ],
      roleKeys: { org: { a: ["doc.read"], b: ["doc.read"] } },
    });
  });

  it("hashes the UTF-8 bytes of its text as sha-256 base64url", () => {
    const { text, hash } = policyBundle(rows);
    expect(hash).toBe(
      `sha-256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("base64url")}`,
    );
    expect(bundleDigest(text)).toBe(hash);
  });

  it("changes the hash when a row or its effect changes", () => {
    const base = policyBundle(rows).hash;
    expect(policyBundle(rows.slice(1)).hash).not.toBe(base);
    const [first, ...rest] = rows;
    expect(policyBundle([{ ...first, effect: "deny" }, ...rest]).hash).not.toBe(
      base,
    );
  });

  it("quotes the body once in its loader", () => {
    const bundle = policyBundle([
      {
        ...rows[0],
        role: "o'brien",
        grantKey: "doc.read",
        permission: "doc.read",
      },
    ]);
    const sql = bundleLoaderSql(ctx(), bundle);
    expect(sql).toContain("o''brien");
    expect(sql).toContain("on conflict (hash) do nothing");
  });
});

describe("rls.staticGrants: 'ref' helpers", () => {
  const { hash } = policyBundle(rows);
  const sql = helpersSql(ctx({ seeds: "view", staticGrants: "ref" }), rows, {
    userRoles: true,
  });

  it("pins the hash and carries no rows", () => {
    expect(sql).toContain(`b.hash = '${hash}'`);
    expect(sql).not.toContain("'doc.read'::text");
    expect(sql).not.toMatch(/values\s*\(\s*'a'/u);
  });

  it("checks the digest of every stored body", () => {
    expect(sql).toContain(
      "constraint permdock_policy_bundle_digest check (hash = 'sha-256:' || translate(rtrim(encode(sha256(convert_to(body, 'UTF8')), 'base64'), '='), '+/', '-_'))",
    );
  });

  it("reads the lookup from the bundle as a stable function", () => {
    expect(sql).toMatch(
      /permdock_role_keys\(p_scope text, p_role text\)\nreturns jsonb\nlanguage sql\nstable/u,
    );
  });

  it("keeps the inline form unchanged without the option", () => {
    const view = helpersSql(ctx({ seeds: "view" }), rows, { userRoles: true });
    expect(view).not.toContain("permdock_policy_bundle");
    expect(view).toContain("immutable");
  });
});

describe("rls.staticGrants validation", () => {
  it("refuses 'ref' next to seeds 'function'", () => {
    expect(() =>
      runPolicyBundle({
        cwd: tmpdir(),
        config: { rls: { seeds: "function", staticGrants: "ref" } },
        policy,
        kind: "bundle",
        out: undefined,
        check: false,
        dryRun: false,
      }),
    ).toThrow(/cannot combine with rls.seeds 'function'/u);
  });

  it("refuses an unknown mode", () => {
    expect(() =>
      runPolicyBundle({
        cwd: tmpdir(),
        // SAFETY: a config from a JavaScript module can hold any string.
        config: { rls: { staticGrants: "outline" as never } },
        policy,
        kind: "bundle",
        out: undefined,
        check: false,
        dryRun: false,
      }),
    ).toThrow(/must be 'inline' or 'ref'/u);
  });
});

describe("permdock policy bundle", () => {
  const base = {
    cwd: tmpdir(),
    config: { rls: { dialect: "guc", staticGrants: "ref" } },
    policy,
    out: undefined,
    check: false,
    dryRun: false,
  } as const;

  it("prints the bundle, its hash and the row count", () => {
    const result = runPolicyBundle({ ...base, kind: "bundle" });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output).rows).toHaveLength(4);
    expect(result.data).toMatchObject({
      rows: 4,
      kind: "bundle",
      hash: bundleDigest(result.output.trimEnd()),
    });
  });

  it("prints the same hash from the loader", () => {
    const bundle = runPolicyBundle({ ...base, kind: "bundle" });
    const load = runPolicyBundle({ ...base, kind: "sql" });
    expect(load.output).toContain(bundleDigest(bundle.output.trimEnd()));
  });

  it("writes a file, then --check passes and a changed file fails", () => {
    const cwd = mkdtempSync(join(tmpdir(), "permdock-policy-bundle-"));
    try {
      const input = {
        ...base,
        cwd,
        kind: "bundle",
        out: "bundle.json",
      } as const;
      expect(runPolicyBundle(input).code).toBe(0);
      expect(runPolicyBundle({ ...input, check: true }).code).toBe(0);
      writeFileSync(join(cwd, "bundle.json"), "{}\n");
      const stale = runPolicyBundle({ ...input, check: true });
      expect(stale.code).toBe(1);
      expect(stale.data).toMatchObject({ stale: true });
      expect(readFileSync(join(cwd, "bundle.json"), "utf8")).toBe("{}\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
