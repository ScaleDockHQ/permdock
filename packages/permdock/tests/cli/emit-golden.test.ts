import { describe, expect, it } from "vitest";

import type { GenModel } from "../../src/cli/gen/model.ts";
import type { PermDockConfig } from "../../src/cli/types.ts";

import { renderGen } from "../../src/cli/gen/emit/render.ts";
import { mergeSchemes } from "../../src/cli/openapi/emit/merge.ts";
import { powersyncFiles } from "../../src/cli/powersync/emit/files.ts";
import {
  grantsLabel,
  supabaseHookSql,
} from "../../src/cli/supabase-hook/emit/hook-sql.ts";
import {
  allow,
  authenticated,
  definePermissions,
  definePolicy,
  principal,
  resource,
} from "../../src/index.ts";
import { tableMembershipSource } from "../../src/supabase/sources.ts";

const permissions = definePermissions({
  job: resource({ id: "id", actions: ["read"] }),
});

const policy = definePolicy(permissions, {
  subject: () => null,
  grants: [
    allow(permissions.job.read, {
      to: authenticated(),
      where: { author_id: principal.id },
    }),
  ],
});

const config: PermDockConfig = {
  policy: "policy.ts",
  rls: { tables: { job: "jobs" } },
  powersync: { resources: ["job"] },
};

describe("emitted parts", () => {
  it("names where the hook grants went", () => {
    expect(grantsLabel(undefined)).toBeUndefined();
    expect(grantsLabel("-")).toBe("a separate migration");
    expect(grantsLabel("supabase/grants.sql")).toBe("supabase/grants.sql");
  });

  it("emits one hook function per signature", async () => {
    const { sql } = supabaseHookSql([], {
      policy: "policy.ts",
      supabase: {
        hook: {
          memberships: [tableMembershipSource({ table: "memberships" })],
        },
      },
    });
    const signatures = sql
      .split("\n")
      .filter((line) => /^create (or replace )?function/u.test(line))
      .toSorted();
    expect(new Set(signatures).size).toBe(signatures.length);
    expect(signatures.length).toBeGreaterThan(0);
    await expect(signatures).toMatchFileSnapshot(
      "__snapshots__/hook-golden-signatures.txt",
    );
  });

  it("emits the PowerSync stream file from the policy", () => {
    const files = powersyncFiles(policy, config);
    expect(files.files.map((file) => file.path)).toStrictEqual([
      "sync-config.yaml",
    ]);
    expect(files.files[0]?.text).toContain("  job:");
  });

  it("keeps an existing OpenAPI flow when it adds scopes", () => {
    expect(
      mergeSchemes(
        {
          oauth: {
            type: "oauth2",
            flows: {
              authorizationCode: { authorizationUrl: "https://example.test" },
            },
          },
        },
        {
          oauth: {
            type: "oauth2",
            flows: { authorizationCode: { scopes: { "job.read": "read" } } },
          },
        },
      ),
    ).toStrictEqual({
      oauth: {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: "https://example.test",
            scopes: { "job.read": "read" },
          },
        },
      },
    });
  });

  it("emits the constants module from the model", () => {
    // SAFETY: the constants emitter reads only the names fields set here.
    const names = {
      schema: "app",
      claims: { tenant: "tenant_id", role: "user_role" },
      scopes: {},
      resources: {},
    } as unknown as GenModel["names"];
    const render = (kind: "constants" | "sql") =>
      renderGen(
        kind,
        {
          resources: [],
          operations: [],
          scopes: [],
          roles: [],
          plans: [],
          names,
          topics: [],
          labels: { permissions: [], roles: [] },
          buckets: [],
        },
        {
          fields: false,
          zodSpecifier: "zod",
          rel: "src/permdock/constants.ts",
          file: "/tmp/constants.ts",
          policy: "/tmp/policy.ts",
          previous: undefined,
          header: { version: "0.0.0", policy: "policy.ts", hash: "digest" },
        },
      );
    expect(render("constants").map((file) => file.name)).toStrictEqual([
      "constants.ts",
    ]);
    expect(render("constants")[0]?.text).toContain("export const roleNames");
    expect(render("sql")[0]?.text).toContain("helperSchema");
  });
});
