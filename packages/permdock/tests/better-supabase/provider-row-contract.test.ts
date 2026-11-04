import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";
import type { RlsDialect } from "../../src/cli/types.ts";

import { authorizationProvider } from "../../src/better-supabase/index.ts";
import { rowHelpersSql } from "../../src/cli/rls/rows.ts";
import { compileGrants } from "../../src/cli/sql/compile.ts";
import { resolveNames } from "../../src/cli/sql/resolve-names.ts";
import { scopeList } from "../../src/core/scopes.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  relation,
  resource,
  role,
} from "../../src/index.ts";
import { supabaseHookManifestFixture } from "../../src/testing/supabase-fixtures.ts";

const permissions = definePermissions({
  doc: resource({
    actions: ["read"],
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      owner: "ownerId",
    },
  }),
  ledger: resource({
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("member", [allow([permissions.doc.read, permissions.ledger.read])], {
      on: "tenant",
    }),
  ],
  grants: [
    allow(permissions.doc.read, { to: relation(permissions.doc, "owner") }),
  ],
  subject: () => null,
});

type Case = {
  readonly name: string;
  readonly dialect: RlsDialect;
  readonly idTypes?: Readonly<Record<string, string>>;
};

const CASES: readonly Case[] = [
  { name: "supabase uuid ids", dialect: "supabase" },
  { name: "neon text ids", dialect: "neon" },
  {
    name: "a custom rls.idTypes",
    dialect: "supabase",
    idTypes: { "*": "bigint" },
  },
];

function generated(item: Case): string {
  const ctx: RlsSqlContext = {
    dialect: item.dialect,
    ...(item.idTypes === undefined ? {} : { idTypes: item.idTypes }),
    scopes: scopeList(policy.scopes),
    tenantClaim: "tenant_id",
    gucPrefix: "app",
  };
  const compiled = compileGrants(policy, ctx, undefined, [], false, true);
  return rowHelpersSql(
    ctx,
    policy,
    [...compiled.branches, ...compiled.actionBranches],
    true,
    undefined,
    [],
  );
}

function signatures(sql: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [, name = "", params = ""] of sql.matchAll(
    /create or replace function "permdock"\.([a-z0-9_]+)\(([^)]*)\)/gu,
  )) {
    const types = params
      .split(",")
      .map((param) =>
        param
          .trim()
          .replace(/\s+default\s+.*$/u, "")
          .split(/\s+/u)
          .slice(1)
          .join(" "),
      )
      .filter((type) => type !== "");
    out.add(`permdock.${name}(${types.join(", ")})`);
  }
  return out;
}

describe("the better-supabase row templates match the generated row helpers", () => {
  for (const item of CASES) {
    it(`requires exactly the signatures rls generate writes for ${item.name}`, () => {
      const names = resolveNames(policy, {
        rls: {
          dialect: item.dialect,
          rowHelpers: true,
          ...(item.idTypes === undefined ? {} : { idTypes: item.idTypes }),
        },
      });
      const provider = authorizationProvider({
        manifest: { ...supabaseHookManifestFixture, names },
        rowHelpers: true,
      });
      const written = signatures(generated(item));
      const rows = (provider.requires ?? []).filter((entry) =>
        /^permdock\.permitted_[a-z0-9_]+_rows(?:_for)?$/u.test(entry.function),
      );
      const expected = rows.filter(
        (entry) =>
          item.dialect !== "neon" || !entry.function.endsWith("_rows_for"),
      );
      expect(expected.length).toBeGreaterThanOrEqual(
        item.dialect === "neon" ? 2 : 4,
      );
      for (const entry of expected) {
        expect(written).toContain(`${entry.function}(${entry.args ?? ""})`);
      }
      const rowsWith = provider.functions.rowsWith ?? "";
      for (const resourceName of ["doc", "ledger"]) {
        const call = rowsWith
          .replaceAll("{resource}", resourceName)
          .replace(/^permdock\./u, "");
        const helper = call.slice(0, call.indexOf("("));
        const entry = rows.find((row) => row.function === `permdock.${helper}`);
        expect(entry?.args).toBe(
          `text, ${names.resources[resourceName]?.idType ?? ""}[]`,
        );
      }
    });
  }

  it("writes no _for helper on neon, so the provider's rowsWithFor needs the supabase dialect", () => {
    expect(
      [...signatures(generated({ name: "neon", dialect: "neon" }))].some(
        (signature) => signature.includes("_rows_for("),
      ),
    ).toBe(false);
  });
});
