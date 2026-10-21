import { afterEach, describe, expect, it } from "vitest";

import { pd070 } from "../../src/cli/doctor/catalog.ts";
import { policyProject, removeProjects } from "./doctor-kit.ts";

afterEach(removeProjects);

const config = { permissions: "src/permissions.ts", policy: "src/policy.ts" };
const POLICY = `roles: [],
  oauthScopes: { 'mcp:read': [permissions.post.read, permissions.note.read] },`;

function catalog(extra: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    $schema: "https://permdock.com/schemas/catalog-v1.json",
    version: 1,
    generatedAt: "2026-10-18T00:00:00Z",
    generator: "test",
    resources: { post: { id: "id", schema: null } },
    permissions: [
      {
        key: "post.read",
        resource: "post",
        action: "read",
        scope: "post:read",
        meta: {},
        arity: "instance",
        usages: [],
        rowConditions: false,
      },
    ],
    ...extra,
  });
}

describe("PD070", () => {
  it("warns when the catalog lacks the policy's oauthScopes", async () => {
    const cwd = policyProject(
      { policy: POLICY },
      { "permissions.catalog.json": catalog() },
    );
    const findings = await pd070({ cwd, config });
    expect(findings).toStrictEqual([
      expect.objectContaining({ code: "PD070", severity: "warning" }),
    ]);
    expect(findings[0]?.message).toContain("mcp:read");
    expect(findings[0]?.message).toContain("lists none");
  });

  it("warns when the catalog lists another set", async () => {
    const cwd = policyProject(
      { policy: POLICY },
      {
        "permissions.catalog.json": catalog({
          oauthScopes: [{ scope: "mcp:read", permissions: ["post.read"] }],
        }),
      },
    );
    const [finding] = await pd070({ cwd, config });
    expect(finding?.message).toContain("other oauthScopes");
  });

  it("passes a current catalog, a policy without oauthScopes and a missing catalog", async () => {
    const current = policyProject(
      { policy: POLICY },
      {
        "permissions.catalog.json": catalog({
          oauthScopes: [
            { scope: "mcp:read", permissions: ["note.read", "post.read"] },
          ],
        }),
      },
    );
    expect(await pd070({ cwd: current, config })).toStrictEqual([]);
    const plain = policyProject(
      { policy: "roles: []," },
      { "permissions.catalog.json": catalog() },
    );
    expect(await pd070({ cwd: plain, config })).toStrictEqual([]);
    const missing = policyProject({ policy: POLICY });
    expect(await pd070({ cwd: missing, config })).toStrictEqual([]);
  });
});
