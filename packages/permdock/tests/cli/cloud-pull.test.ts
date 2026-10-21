import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CatalogDocument } from "../../src/catalog/types.ts";
import type { CliIo } from "../../src/cli/types.ts";

import { run } from "../../src/cli/core/run.ts";
import { catalogFingerprint } from "../../src/core/catalog-fingerprint.ts";
import { writeCredentials } from "../../src/terminal/storage.ts";
import { POLICY_NOT_PUBLISHED } from "../../src/testing/cloud-api/platform.ts";
import { referenceCloud } from "../cloud/fixtures/reference-cloud.ts";
import { policy } from "../fixtures/named-scopes.ts";
import { jsonData } from "./envelope.ts";
import { SOURCES, generate, removeHookProjects } from "./supabase-hook-kit.ts";

// Credentials go to the XDG_CONFIG_HOME file, never the developer's keychain.
vi.mock("@napi-rs/keyring", () => {
  throw new Error("@napi-rs/keyring is not installed");
});

afterEach(removeHookProjects);

const NOW = new Date("2026-10-18T09:00:00.000Z");
const CATALOG = "permissions.catalog.json";
const MANIFEST = "permdock.manifest.json";

type Cloud = Awaited<ReturnType<typeof referenceCloud>>;

const SEED: CatalogDocument = {
  $schema: "https://permdock.com/schemas/catalog-v1.json",
  version: 1,
  generatedAt: "2026-10-01T00:00:00.000Z",
  generator: "permdock@0.4.0",
  resources: { post: { id: "id", schema: { type: "object" } } },
  permissions: [
    {
      key: "post.read",
      resource: "post",
      action: "read",
      scope: "post:read",
      arity: "instance",
      meta: {},
      usages: [],
      rowConditions: false,
    },
  ],
};

function cloud(): Promise<Cloud> {
  return referenceCloud(policy, SEED);
}

function io(
  reference: Cloud,
  env: Readonly<Record<string, string>>,
  fetchFn: typeof fetch = reference.fetch,
): CliIo {
  return {
    stdout: () => undefined,
    stderr: () => undefined,
    now: () => NOW,
    fetch: fetchFn,
    env: { PERMDOCK_CLOUD_URL: reference.url, ...env },
  };
}

/**
 * A project with the offline catalog and manifest written, then pushed with
 * them.
 */
async function pushedProject(
  reference: Cloud,
): Promise<{
  readonly cwd: string;
  readonly catalog: string;
  readonly manifest: string;
}> {
  const { cwd } = await generate(`{ memberships: [${SOURCES}] }`);
  const offline = io(reference, {});
  expect((await run(["collect"], { cwd, io: offline })).code).toBe(0);
  expect(
    (await run(["supabase", "inspect", "--out"], { cwd, io: offline })).code,
  ).toBe(0);
  const push = await run(
    [
      "cloud",
      "push",
      "--project",
      reference.environment,
      "--manifest",
      MANIFEST,
    ],
    { cwd, io: io(reference, { PERMDOCK_CLOUD_KEY: reference.keys.client }) },
  );
  expect(push.code).toBe(0);
  return {
    cwd,
    catalog: readFileSync(join(cwd, CATALOG), "utf8"),
    manifest: readFileSync(join(cwd, MANIFEST), "utf8"),
  };
}

describe("permdock cloud push manifest", () => {
  const push = async (
    manifest: string | undefined,
    write?: string,
  ): Promise<{ code: number; output: string }> => {
    const reference = await cloud();
    const { cwd } = await generate(`{ memberships: [${SOURCES}] }`);
    expect((await run(["collect"], { cwd, io: io(reference, {}) })).code).toBe(
      0,
    );
    if (write !== undefined) {
      writeFileSync(join(cwd, MANIFEST), write);
    }
    const result = await run(
      [
        "cloud",
        "push",
        "--project",
        reference.environment,
        ...(manifest === undefined ? [] : ["--manifest", manifest]),
      ],
      { cwd, io: io(reference, { PERMDOCK_CLOUD_KEY: reference.keys.client }) },
    );
    return { code: result.code, output: result.stdout + result.stderr };
  };

  it("refuses a --manifest file that does not exist", async () => {
    const result = await push("missing.json");
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("missing.json does not exist");
  });

  it("refuses a manifest that does not parse", async () => {
    const result = await push(undefined, "{}");
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("is not a valid manifest");
  });
});

describe("permdock cloud pull", () => {
  it("writes the bytes collect and supabase inspect --out write", async () => {
    const reference = await cloud();
    const project = await pushedProject(reference);
    rmSync(join(project.cwd, CATALOG));
    rmSync(join(project.cwd, MANIFEST));
    const pulled = await run(["cloud", "pull", "--json"], {
      cwd: project.cwd,
      io: io(reference, { PERMDOCK_CLOUD_TOKEN: reference.platform.token }),
    });
    expect(pulled.code).toBe(0);
    expect(readFileSync(join(project.cwd, CATALOG), "utf8")).toBe(
      project.catalog,
    );
    expect(readFileSync(join(project.cwd, MANIFEST), "utf8")).toBe(
      project.manifest,
    );
    expect(jsonData(pulled.stdout)).toMatchObject({
      project: reference.environment,
      version: 2,
      fingerprint: catalogFingerprint(JSON.parse(project.catalog)),
    });
  });

  it("restores the previous files when the fingerprint does not match", async () => {
    const reference = await cloud();
    const project = await pushedProject(reference);
    writeFileSync(join(project.cwd, CATALOG), "previous\n");
    const tampered: typeof fetch = async (input, init) => {
      const response = await reference.fetch(input, init);
      if (
        !new URL(
          String(input instanceof Request ? input.url : input),
        ).pathname.endsWith("/policy")
      ) {
        return response;
      }
      const body = await response.json();
      return Response.json({ ...body, fingerprint: "sha256:other" });
    };
    const pulled = await run(
      ["cloud", "pull", "--project", reference.environment],
      {
        cwd: project.cwd,
        io: io(
          reference,
          { PERMDOCK_CLOUD_TOKEN: reference.platform.token },
          tampered,
        ),
      },
    );
    expect(pulled.code).toBe(1);
    expect(pulled.stdout).toContain("fingerprint");
    expect(readFileSync(join(project.cwd, CATALOG), "utf8")).toBe("previous\n");
    expect(readFileSync(join(project.cwd, MANIFEST), "utf8")).toBe(
      project.manifest,
    );
  });

  it("answers policy-not-published as Problem Details under --json", async () => {
    const reference = await cloud();
    const { cwd } = await generate(`{ memberships: [${SOURCES}] }`);
    const config = join(cwd, "config");
    writeCredentials(
      { service: "permdock" },
      reference.url,
      { access_token: reference.platform.login, token_type: "Bearer" },
      { env: { XDG_CONFIG_HOME: config } },
    );
    const pulled = await run(
      ["cloud", "pull", "--project", reference.platform.unpublished, "--json"],
      { cwd, io: io(reference, { XDG_CONFIG_HOME: config }) },
    );
    expect(pulled.code).toBe(1);
    expect(jsonData(pulled.stdout)).toMatchObject({
      type: POLICY_NOT_PUBLISHED,
      status: 404,
    });
  });

  it("needs a token or a login", async () => {
    const reference = await cloud();
    const { cwd } = await generate(`{ memberships: [${SOURCES}] }`);
    const pulled = await run(["cloud", "pull", "--project", "test"], {
      cwd,
      io: io(reference, { XDG_CONFIG_HOME: join(cwd, "config") }),
    });
    expect(pulled.code).toBe(3);
    expect(pulled.stderr).toContain("PERMDOCK_CLOUD_TOKEN");
  });

  it("refuses a read-only token on another project", async () => {
    const reference = await cloud();
    const { cwd } = await generate(`{ memberships: [${SOURCES}] }`);
    const pulled = await run(
      ["cloud", "pull", "--project", reference.platform.unpublished],
      {
        cwd,
        io: io(reference, { PERMDOCK_CLOUD_TOKEN: reference.platform.token }),
      },
    );
    expect(pulled.code).toBe(3);
    expect(pulled.stderr).toMatch(/403/u);
  });
});

describe("permdock rls generate --project", () => {
  it("generates the same SQL from the pushed catalog and policy", async () => {
    const reference = await cloud();
    const project = await pushedProject(reference);
    const local = await run(["rls", "generate", "--out", "local.sql"], {
      cwd: project.cwd,
      io: io(reference, {}),
    });
    expect(local.code).toBe(0);
    const hosted = await run(
      [
        "rls",
        "generate",
        "--out",
        "hosted.sql",
        "--project",
        reference.environment,
      ],
      {
        cwd: project.cwd,
        io: io(reference, { PERMDOCK_CLOUD_TOKEN: reference.platform.token }),
      },
    );
    expect(hosted.stderr).toBe("");
    expect(hosted.code).toBe(0);
    expect(readFileSync(join(project.cwd, "hosted.sql"), "utf8")).toBe(
      readFileSync(join(project.cwd, "local.sql"), "utf8"),
    );
  });

  it("refuses --project with a --from policy module", async () => {
    const reference = await cloud();
    const { cwd } = await generate(`{ memberships: [${SOURCES}] }`);
    const result = await run(
      ["rls", "generate", "--project", "test", "--policy", "./policy.ts"],
      { cwd, io: io(reference, {}) },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not both");
  });

  it("refuses --project for another rls action", async () => {
    const reference = await cloud();
    const { cwd } = await generate(`{ memberships: [${SOURCES}] }`);
    const result = await run(["rls", "check", "--project", "test"], {
      cwd,
      io: io(reference, {}),
    });
    expect(result.code).toBe(2);
  });
});
