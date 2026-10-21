import { afterEach, describe, expect, it } from "vitest";

import { pd077 } from "../../src/cli/doctor/config-names.ts";
import { policyProject, removeProjects } from "./doctor-kit.ts";

describe("doctor config names", () => {
  afterEach(removeProjects);

  const cwd = () =>
    policyProject({ policy: "scopes: { organization: { key: 'orgId' } }," });

  it("names each scope, resource and action the policy does not declare", async () => {
    const findings = await pd077({
      cwd: cwd(),
      config: {
        policy: "src/policy.ts",
        rls: {
          tables: { post: "posts", posts: "posts" },
          scopeTypes: { organisation: "uuid" },
          actions: { publish: "update" },
          realtime: {
            topics: {
              "org:{organisation}:posts": { read: { key: "post.read" } },
              "org:{organization}:chat": { read: { key: "post.read" } },
            },
          },
          storage: { buckets: { files: { scope: "org" } } },
        },
        powersync: { resources: ["comment"], action: "read" },
      },
    });
    expect(findings.map((finding) => finding.message)).toStrictEqual([
      "rls.tables names the resource 'posts', which the policy does not declare",
      "rls.scopeTypes names the scope 'organisation', which the policy does not declare",
      "rls.actions names the action 'publish', which the policy does not declare",
      "rls.realtime.topics['org:{organisation}:posts'] names the scope 'organisation', which the policy does not declare",
      "rls.storage.buckets.files.scope names the scope 'org', which the policy does not declare",
      "powersync.resources names the resource 'comment', which the policy does not declare",
    ]);
    expect(findings[1]).toMatchObject({
      code: "PD077",
      severity: "error",
      fix: "use one of organization, team, tenant, or pass the policy value to defineConfig to catch this at compile time",
    });
  });

  it("reports a SQL helper name Postgres would truncate", async () => {
    const long = "a".repeat(47);
    const findings = await pd077({
      cwd: policyProject({ policy: `scopes: { ${long}: { key: 'orgId' } },` }),
      config: { policy: "src/policy.ts" },
    });
    expect(findings).toStrictEqual([
      {
        code: "PD077",
        severity: "error",
        message: `scope '${long}' names the SQL helper 'permitted_${long}_ids_for', longer than the 63 bytes Postgres keeps; shorten the name`,
        fix: "rename the scope or resource so each generated SQL helper has its own name of at most 63 bytes",
      },
    ]);
  });

  it("finds nothing without a policy", async () => {
    expect(
      await pd077({ cwd: cwd(), config: { rls: { tables: { x: "x" } } } }),
    ).toStrictEqual([]);
  });
});
