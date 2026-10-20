import { afterEach, describe, expect, it, vi } from "vitest";

import type { CliIo } from "../../src/cli/types.ts";

import { runCloud } from "../../src/cli/cloud/push.ts";
import { CliError, problemOf } from "../../src/cli/core/errors.ts";

const catalog = {
  $schema: "https://permdock.com/schemas/catalog-v1.json",
  version: 1,
  generatedAt: "2026-10-01T00:00:00.000Z",
  generator: "permdock@0.1.0",
  resources: { post: { id: "id", schema: null } },
  permissions: [
    {
      key: "post.read",
      scope: "post:read",
      resource: "post",
      action: "read",
      arity: "instance",
      meta: {},
      usages: [],
      rowConditions: false,
    },
  ],
  roles: [{ key: "admin", on: "workspace" }],
  grants: [
    {
      permission: "post.delete",
      effect: "allow",
      role: "admin",
      to: null,
      scope: "tenant",
    },
  ],
};

vi.mock("../../src/cli/catalog.ts", () => ({
  runCatalog: () =>
    Promise.resolve({ code: 0, output: JSON.stringify(catalog) }),
}));

const fetchSpy = vi.fn<typeof fetch>();

afterEach(() => {
  vi.unstubAllGlobals();
  fetchSpy.mockReset();
});

function push(dryRun: boolean) {
  vi.stubGlobal("fetch", fetchSpy);
  return runCloud({
    cwd: import.meta.dirname,
    config: {},
    url: undefined,
    dryRun,
    json: false,
    env: {
      PERMDOCK_CLOUD_URL: "https://cloud.permdock.test",
      PERMDOCK_CLOUD_KEY: "key",
    },
    now: new Date("2026-10-01T00:00:00.000Z"),
    // SAFETY: runCatalog is mocked, so nothing reads from io.
    io: {} as CliIo,
  });
}

async function failure(dryRun: boolean): Promise<CliError> {
  const error: unknown = await push(dryRun).catch((thrown: unknown) => thrown);
  if (!(error instanceof CliError)) {
    throw new TypeError("expected a CliError");
  }
  return error;
}

describe("cloud push on an invalid catalog", () => {
  it("lists every issue with its path on --dry-run", async () => {
    const error = await failure(true);
    expect(error.code).toBe("catalog_invalid");
    expect(error.message).toBe(
      [
        "permdock cloud push: the catalog has 2 issues",
        "  roles.0.on: role 'admin' is on 'workspace', which is neither a declared scope nor resource",
        "  grants.0.permission: grant 'post.delete' is not a declared permission key",
      ].join("\n"),
    );
  });

  it("returns a Problem with issues for --json", async () => {
    const problem = problemOf(await failure(true), "cloud push");
    expect(problem).toMatchObject({
      type: "https://permdock.com/docs/cli/errors#catalog_invalid",
      title: "Invalid catalog",
      code: "catalog_invalid",
      exitCode: 1,
      issues: [
        { path: "roles.0.on", message: expect.any(String) },
        { path: "grants.0.permission", message: expect.any(String) },
      ],
    });
  });

  it("refuses a real push before any request", async () => {
    expect((await failure(false)).code).toBe("catalog_invalid");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
