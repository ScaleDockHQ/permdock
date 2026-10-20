import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { runCloud } from "../../src/cli/cloud/push.ts";
import { CliError, problemOf } from "../../src/cli/core/errors.ts";
import {
  NOW,
  PERMISSIONS,
  project,
  quietIo,
  removeProjects,
} from "./doctor-kit.ts";

afterAll(removeProjects);

const fetchSpy = vi.fn<typeof fetch>();

afterEach(() => {
  vi.unstubAllGlobals();
  fetchSpy.mockReset();
});

const leaf = (key: string) =>
  JSON.stringify({
    key,
    scope: key.replace(".", ":"),
    resource: key.split(".")[0],
    action: key.split(".")[1],
    meta: {},
  });

/** Operations over leaves of another tree, so the catalog names keys it never declares. */
const OPERATIONS = `export const operations = {
  archivePost: { name: 'archivePost', permission: ${leaf("post.archive")}, results: ${leaf("ghost.list")}, meta: {} },
};
`;

function push(dryRun: boolean, operations = OPERATIONS) {
  vi.stubGlobal("fetch", fetchSpy);
  return runCloud({
    cwd: project({
      "src/permissions.ts": PERMISSIONS,
      "src/operations.ts": operations,
    }),
    config: {
      permissions: "src/permissions.ts",
      operations: "src/operations.ts",
    },
    url: undefined,
    dryRun,
    json: false,
    env: {
      PERMDOCK_CLOUD_URL: "https://cloud.permdock.test",
      PERMDOCK_CLOUD_KEY: "key",
    },
    now: NOW,
    io: quietIo,
  });
}

async function failure(
  dryRun: boolean,
  operations?: string,
): Promise<CliError> {
  const error: unknown = await push(dryRun, operations).catch(
    (thrown: unknown) => thrown,
  );
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
        "  operations.0.permission: operation 'archivePost' permission 'post.archive' is not a declared permission key",
        "  operations.0.results: operation 'archivePost' results 'ghost.list' is not a declared permission key",
      ].join("\n"),
    );
  });

  it("counts a single issue in the singular", async () => {
    const one = `export const operations = {
  readPost: { name: 'readPost', permission: ${leaf("post.read")}, results: ${leaf("ghost.list")}, meta: {} },
};
`;
    expect((await failure(true, one)).message).toBe(
      [
        "permdock cloud push: the catalog has 1 issue",
        "  operations.0.results: operation 'readPost' results 'ghost.list' is not a declared permission key",
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
        { path: "operations.0.permission", message: expect.any(String) },
        { path: "operations.0.results", message: expect.any(String) },
      ],
    });
  });

  it("refuses a real push before any request", async () => {
    expect((await failure(false)).code).toBe("catalog_invalid");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
