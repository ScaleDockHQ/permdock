import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";

import { pd061 } from "../../src/cli/doctor/suspension.ts";
import {
  activeMembershipSql,
  checkSuspension,
  keptRowSql,
} from "../../src/cli/sql/active.ts";

const ctx = (keep?: readonly string[], permission?: string): RlsSqlContext => ({
  dialect: "supabase",
  tenantClaim: "tenant_id",
  gucPrefix: "request.jwt",
  scopes: [{ name: "organization" }],
  ...(keep === undefined ? {} : { suspension: { memberships: { keep } } }),
  ...(permission === undefined ? {} : { permission }),
});

describe("activeMembershipSql", () => {
  it("adds nothing without a disabledAt column", () => {
    expect(activeMembershipSql(ctx(["a.read"]), undefined)).toStrictEqual([]);
  });

  it("drops the check for a kept permission known now", () => {
    expect(activeMembershipSql(ctx(["a.read"], "a.read"), "m.d")).toStrictEqual(
      [],
    );
    expect(
      activeMembershipSql(ctx(["a.read"], "a.write"), "m.d"),
    ).toStrictEqual(["m.d is null"]);
  });

  it("compares a permission read at run time with the kept keys", () => {
    expect(
      activeMembershipSql(ctx(["a.read"]), "m.d", { sql: "p_grant" }),
    ).toStrictEqual([
      "(m.d is null or p_grant = any(array['a.read']::text[]))",
    ]);
    expect(activeMembershipSql(ctx(), "m.d", { sql: "p_grant" })).toStrictEqual(
      ["m.d is null"],
    );
  });
});

describe("keptRowSql", () => {
  it("admits a row without keep, or one whose keep holds the permission", () => {
    expect(keptRowSql("ms.keep", undefined)).toBe(
      "coalesce(jsonb_typeof(ms.keep), 'null') = 'null'",
    );
    expect(keptRowSql("ms.keep", { key: "a.read" })).toBe(
      "case coalesce(jsonb_typeof(ms.keep), 'null') when 'null' then true when 'array' then ms.keep @> jsonb_build_array('a.read') else false end",
    );
  });
});

describe("checkSuspension memberships", () => {
  it("keeps the sorted keys and drops an empty keep", () => {
    expect(
      checkSuspension({ memberships: { keep: ["b", { key: "a" }] } }, []),
    ).toStrictEqual({ memberships: { keep: ["a", "b"] } });
    expect(checkSuspension({ memberships: {} }, [])).toStrictEqual({});
  });
});

describe("PD061 for a malformed membership keep", () => {
  it("reports an entry it cannot read", async () => {
    const findings = await pd061({
      cwd: ".",
      config: {
        policy: "./policy.ts",
        rls: { suspension: { memberships: { keep: [""] } } },
      },
      policy: () => Promise.resolve(undefined),
    });
    expect(findings.map((item) => item.message)).toStrictEqual([
      "rls.suspension.memberships.keep has an entry that is neither a permission nor a permission key, so generate refuses it",
    ]);
  });
});
