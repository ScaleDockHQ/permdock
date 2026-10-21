import { describe, expectTypeOf, it } from "vitest";

import type { RlsMigrateHelper } from "../../src/cli/types.ts";

import { defineConfig } from "../../src/cli/index.ts";
import { definePermissions, definePolicy, resource } from "../../src/index.ts";

describe("rls config", () => {
  it("accepts helpersOnly and the migrate helper forms", () => {
    const config = defineConfig({
      policy: "./policy.ts",
      rls: {
        helpersOnly: true,
        migrate: {
          helpers: {
            org_ids_with_permission: { form: "ids", scope: "organization" },
            authorize_scope: { form: "scoped" },
            is_system_user_with: { form: "global" },
          },
          prefixes: { "organization.": "" },
          globalScopes: ["system"],
        },
      },
    });
    expectTypeOf(config.rls?.helpersOnly).toExtend<boolean | undefined>();
  });

  it("needs a scope on the scope-bound forms", () => {
    expectTypeOf({ form: "row" } as const).not.toExtend<RlsMigrateHelper>();
    expectTypeOf({
      form: "membership",
      scope: "organization",
    } as const).toExtend<RlsMigrateHelper>();
  });
});

const posts = definePermissions({
  post: resource({ actions: ["read", "update"] }),
  billing: resource({ name: "platform_billing", actions: ["view"] }),
});

const policy = definePolicy(posts, {
  subject: () => null,
  scopes: {
    organization: { key: "orgId" },
    project: { key: "projectId", within: "organization" },
  },
});

describe("a config typed by its policy value", () => {
  it("accepts the names the policy declares", () => {
    const config = defineConfig({
      policy,
      rls: {
        tables: { post: "posts", platform_billing: "billing" },
        scopeTypes: { organization: "uuid" },
        actions: { update: "update" },
        memberships: {
          scopes: {
            project: {
              table: "project_members",
              user: "user_id",
              role: "role",
            },
          },
        },
        realtime: {
          topics: { "org:{organization}:posts": { read: posts.post.read } },
        },
        storage: { buckets: { files: { scope: "project" } } },
        suspension: {
          scopes: {
            organization: { table: "orgs", id: "id", keep: ["post.read"] },
          },
        },
      },
      powersync: { resources: ["post"], action: "read" },
    });
    expectTypeOf(config.policy).toExtend<typeof policy>();
  });

  it("refuses a resource, scope or action the policy does not declare", () => {
    // @ts-expect-error the policy has no resource named posts
    defineConfig({ policy, rls: { tables: { posts: "posts" } } });
    // @ts-expect-error the scope is organization, not organisation
    defineConfig({ policy, rls: { scopeTypes: { organisation: "uuid" } } });
    // @ts-expect-error the policy has no delete action
    defineConfig({ policy, rls: { actions: { delete: "delete" } } });
    defineConfig({
      policy,
      // @ts-expect-error a bucket scope must be a declared scope
      rls: { storage: { buckets: { f: { scope: "org" } } } },
    });
    defineConfig({
      policy,
      // @ts-expect-error keep names a permission key the policy does not have
      rls: { suspension: { memberships: { keep: ["post.delete"] } } },
    });
    // @ts-expect-error powersync streams a resource the policy does not have
    defineConfig({ policy, powersync: { resources: ["comment"] } });
  });

  it("checks each topic placeholder against the scopes", () => {
    defineConfig({
      policy,
      rls: {
        realtime: {
          // @ts-expect-error the scope is organization, not organisation
          topics: { "org:{organisation}:quotes": { read: posts.post.read } },
        },
      },
    });
  });

  it("leaves a config with a policy path untyped", () => {
    defineConfig({
      policy: "./policy.ts",
      rls: { tables: { anything: "t" }, scopeTypes: { whatever: "uuid" } },
    });
  });
});
