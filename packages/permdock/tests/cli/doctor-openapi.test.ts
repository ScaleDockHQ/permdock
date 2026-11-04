import { afterAll, describe, expect, it } from "vitest";

import { pd091, pd091Applies } from "../../src/cli/doctor/openapi.ts";
import { loadProject } from "../../src/cli/project/project.ts";
import { NOW, project, quietIo, removeProjects } from "./doctor-kit.ts";

describe("PD091 operation coverage", () => {
  afterAll(removeProjects);

  const OPERATIONS = `export const operations = {
  entries: () => [
    { method: 'GET', path: '/orgs/{org}/posts' },
    { method: 'GET', path: '/orgs/{org}/old' },
  ],
};
export const other = { entries: () => [] };
`;
  const DOC = JSON.stringify({
    paths: {
      "/orgs/{orgId}/posts": { get: {}, post: {} },
      "/health": { get: {} },
    },
  });

  const run = (config: Parameters<typeof loadProject>[0]["config"]) => {
    const cwd = project({
      "src/operations.ts": OPERATIONS,
      "openapi.json": DOC,
      "broken.json": "{",
    });
    return pd091(loadProject({ cwd, config, now: NOW, io: quietIo }));
  };

  it("runs only when operations, tenantPaths and a document are configured", () => {
    expect(pd091Applies({})).toBe(false);
    expect(
      pd091Applies({
        openapi: {
          operations: "src/operations.ts",
          tenantPaths: ["/orgs/{org}"],
          doc: ["openapi.json"],
        },
      }),
    ).toBe(true);
  });

  it("reports an undeclared tenant-path operation and a stale entry", async () => {
    const findings = await run({
      openapi: {
        operations: "src/operations.ts#operations",
        tenantPaths: ["/orgs/{org}"],
        doc: ["openapi.json"],
      },
    });
    expect(findings.map((finding) => finding.message)).toStrictEqual([
      "openapi.json: POST /orgs/{orgId}/posts is under a tenant path and has no entry in src/operations.ts#operations, so the gate denies it",
      "openapi.json: src/operations.ts#operations declares GET /orgs/{org}/old, which the document does not contain",
    ]);
    expect(findings.every((finding) => finding.severity === "error")).toBe(
      true,
    );
  });

  it("reports an export that is not an operationPermissions result, and a bad document", async () => {
    const missing = await run({
      openapi: {
        operations: "src/operations.ts#nope",
        tenantPaths: ["/orgs/{org}"],
        doc: ["openapi.json"],
      },
    });
    expect(missing[0]?.message).toContain("is not an operationPermissions");
    const broken = await run({
      openapi: {
        operations: "src/operations.ts#other",
        tenantPaths: ["/orgs/{org}"],
        doc: ["broken.json"],
      },
    });
    expect(broken[0]?.message).toContain("is not valid JSON");
  });

  it("is quiet without operations or tenantPaths and skips a document that is not on disk", async () => {
    expect(
      await run({ openapi: { tenantPaths: ["/orgs/{org}"] } }),
    ).toStrictEqual([]);
    expect(
      await run({ openapi: { operations: "src/operations.ts#operations" } }),
    ).toStrictEqual([]);
    expect(
      await run({
        openapi: {
          operations: "src/operations.ts#operations",
          tenantPaths: ["/orgs/{org}"],
          doc: ["absent.json"],
        },
      }),
    ).toStrictEqual([]);
  });

  it("reports an operations module that does not load, and strips base from the fix", async () => {
    const [unloaded] = await run({
      openapi: {
        operations: "src/missing.ts#operations",
        tenantPaths: ["/orgs/{org}"],
      },
    });
    expect(unloaded?.message).toContain(
      "openapi.operations 'src/missing.ts#operations' does not load",
    );
    const based = await run({
      openapi: {
        operations: "src/operations.ts#operations",
        tenantPaths: ["/api/orgs/{org}"],
        base: "/api",
        doc: ["openapi.json"],
      },
    });
    expect(Array.isArray(based)).toBe(true);
  });

  it("defaults the export to operations, and applies only with a non-empty doc list", async () => {
    expect(
      await run({
        openapi: {
          operations: "src/operations.ts",
          tenantPaths: ["/orgs/{org}"],
        },
      }),
    ).toStrictEqual([]);
    for (const doc of [undefined, []] as const) {
      expect(
        pd091Applies({
          openapi: {
            operations: "src/operations.ts",
            tenantPaths: ["/orgs/{org}"],
            ...(doc === undefined ? {} : { doc }),
          },
        }),
      ).toBe(false);
    }
    expect(pd091Applies({ openapi: { operations: "src/operations.ts" } })).toBe(
      false,
    );
  });
});
