import { testAuthorizationProvider } from "better-supabase/testing";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { AuthorizationProviderOptions } from "../../src/better-supabase/index.ts";
import type { SupabaseHookManifest } from "../../src/supabase/manifest.ts";

import { authorizationProvider } from "../../src/better-supabase/index.ts";
import { anyOf, holder, user } from "../../src/core/approvers.ts";
import { supabaseHookManifestFixture } from "../../src/testing/supabase-fixtures.ts";

const ROOT = new URL("../../../../", import.meta.url);
const EXAMPLE = new URL("apps/examples/next-better-supabase/", ROOT);
const text = (url: URL): string => readFileSync(url, "utf8");
const json = (url: URL): unknown => JSON.parse(text(url));

const emptyCatalog = {
  $schema: "https://permdock.com/schemas/catalog-v2.json",
  version: 2,
  generatedAt: "2026-01-01T00:00:00Z",
  generator: "test",
  resources: {},
  permissions: [],
};

const approve = {
  key: "invoice.approve",
  scope: "invoice:approve",
  resource: "invoice",
  action: "approve",
  meta: {},
  kind: "collection",
} as const;

const helper = (name: string, args: string, returns = "boolean") => ({
  name,
  args,
  returns,
  execute: ["authenticated"],
});

const everyTemplate: SupabaseHookManifest = {
  ...supabaseHookManifestFixture,
  names: {
    schema: "permdock",
    gucPrefix: "permdock",
    claims: { tenant: "tenant_id", role: "role" },
    scopes: {},
    resources: {
      fileNode: { rows: "permitted_file_node_rows", idType: "uuid" },
    },
  },
  rls: {
    ...supabaseHookManifestFixture.rls,
    scopes: [
      { name: "tenant", type: "uuid" },
      { name: "team", type: "uuid", within: "tenant" },
    ],
    helpers: [
      ...supabaseHookManifestFixture.rls.helpers,
      helper("permdock_is_approver", "p_approvers jsonb, p_tenant text"),
      helper("member_team_ids_of", "p_user uuid", "setof uuid"),
    ],
  },
};

const combined: AuthorizationProviderOptions = {
  manifest: everyTemplate,
  catalog: {
    ...emptyCatalog,
    permissions: [
      {
        key: "invoice.approve",
        scope: "tenant",
        resource: "invoice",
        action: "approve",
        arity: "collection",
        meta: {},
        usages: [],
        rowConditions: false,
      },
    ],
  },
  rowHelpers: true,
  approver: approve,
  approvers: {
    "invoice.send": [user("u'1"), holder(approve)],
    "support-session": anyOf(user("u1"), holder(approve)),
  },
};

const fixture: AuthorizationProviderOptions = {
  manifest: supabaseHookManifestFixture,
  catalog: emptyCatalog,
};

const example: AuthorizationProviderOptions = {
  manifest: text(new URL("permdock.manifest.json", EXAMPLE)),
  catalog: json(new URL("permissions.catalog.json", EXAMPLE)),
  rowHelpers: true,
};

const providers: readonly (readonly [string, AuthorizationProviderOptions])[] =
  [
    ["the fixture", fixture],
    ["the example", example],
    ["row helpers, approvers and teams", combined],
  ];

const isReport = (
  value: unknown,
): value is { checks: readonly { name: string; ok: boolean }[] } =>
  typeof value === "object" &&
  value !== null &&
  "checks" in value &&
  Array.isArray(value.checks);

async function failedChecks(
  provider: ReturnType<typeof authorizationProvider>,
): Promise<string[]> {
  try {
    await testAuthorizationProvider(provider);
    return [];
  } catch (error) {
    const report =
      error instanceof Error && "report" in error ? error.report : undefined;
    if (!isReport(report)) throw error;
    return report.checks
      .filter((check) => !check.ok)
      .map((check) => check.name);
  }
}

describe("better-supabase 0.26 to 0.63", () => {
  it.each(providers)(
    "0.27: every template of %s passes the template tokenizer",
    async (_, options) => {
      const failed = await failedChecks(authorizationProvider(options));
      expect(failed).not.toContain("templates use only their placeholders");
      expect(failed).not.toContain("templates are safe to inline");
    },
  );

  it("0.33: the conformance kit passes for the fixture, the example and the combined provider", async () => {
    expect(await failedChecks(authorizationProvider(fixture))).toStrictEqual(
      [],
    );
    expect(await failedChecks(authorizationProvider(example))).toStrictEqual(
      [],
    );
    expect(await failedChecks(authorizationProvider(combined))).toStrictEqual(
      [],
    );
  });

  it("0.27: the combined provider fills every template PermDock writes", () => {
    expect(
      Object.keys(authorizationProvider(combined).functions),
    ).toStrictEqual(
      expect.arrayContaining([
        "idsWith",
        "isPlatform",
        "memberIds",
        "rowsWith",
        "rowsWithFor",
        "isApprover",
        "teamIdsOf",
      ]),
    );
  });

  it.each(providers)(
    "0.33: %s names one truncated marker for the hook and its budget",
    (_, options) => {
      const hook = authorizationProvider(options).tokenHook;
      expect(hook?.truncatedClaim).toBe(hook?.budget?.truncatedClaim);
    },
  );
});
