import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { CliIo, PermDockConfig } from "../../src/cli/types.ts";

import { pushedPolicy, runCloud } from "../../src/cli/cloud/push.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  principal,
  resource,
  role,
} from "../../src/index.ts";
import { policy as namedScopes } from "../fixtures/named-scopes.ts";

// Credentials go to the XDG_CONFIG_HOME file, never the developer's keychain.
vi.mock("@napi-rs/keyring", () => {
  throw new Error("@napi-rs/keyring is not installed");
});

const FIXTURE = path.join(import.meta.dirname, "fixtures/mini-app");
const TMP = path.join(import.meta.dirname, "../../tmp");
const NOW = new Date("2026-10-01T00:00:00.000Z");
const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function tempDir(): string {
  mkdirSync(TMP, { recursive: true });
  const created = mkdtempSync(path.join(TMP, "cloud-push-"));
  temps.push(created);
  return created;
}

const tree = definePermissions({
  doc: resource({ actions: ["read", "share", "purge"], collection: ["list"] }),
});

describe("pushedPolicy", () => {
  it("keeps portable conditions and marks closures non-portable", () => {
    const policy = definePolicy(tree, {
      roles: [
        role("member", [
          allow(tree.doc.read, { where: { ownerId: principal.id } }),
          allow(tree.doc.share, () => true),
          allow(tree.doc.list, { limit: { count: 10, per: 3600 } }),
          deny(tree.doc.purge),
        ]),
        role("editor", [allow(tree.doc.share)], { on: tree.doc }),
      ],
      subject: () => null,
    });
    const pushed = pushedPolicy(policy);
    expect(pushed.v).toBe(1);
    expect(pushed.fingerprint).toBe(policy.fingerprint);
    expect(pushed).not.toHaveProperty("scopes");
    const member = { kind: "role", role: "member", scope: "global" };
    expect(JSON.parse(JSON.stringify(pushed.grants))).toEqual([
      {
        permission: "doc.read",
        effect: "allow",
        role: "member",
        to: member,
        where: { op: "eq", field: "ownerId", value: { ref: "principal.id" } },
      },
      {
        permission: "doc.share",
        effect: "allow",
        role: "member",
        to: member,
        portable: false,
        closure: true,
      },
      {
        permission: "doc.list",
        effect: "allow",
        role: "member",
        to: member,
        portable: false,
        limit: { count: 10, per: 3600 },
      },
      { permission: "doc.purge", effect: "deny", role: "member", to: member },
      {
        permission: "doc.share",
        effect: "allow",
        role: "editor",
        to: { kind: "role", role: "editor", scope: { resource: "doc" } },
        scope: { resource: "doc" },
      },
    ]);
  });

  it("carries the declared scopes and a named-scope grant scope", () => {
    const pushed = pushedPolicy(namedScopes);
    expect(pushed.scopes).toEqual([
      {
        name: "organization",
        key: "organization_id",
        resources: ["quote", "invoice", "asset"],
      },
      {
        name: "customer",
        key: "customer_id",
        within: "organization",
        resources: ["quote", "invoice", "asset"],
      },
    ]);
    expect(
      pushed.grants.find(
        (grant) =>
          grant.role === "contact" && grant.permission === "quote.accept",
      ),
    ).toMatchObject({
      scope: "customer",
      where: { op: "eq", field: "status", value: "sent" },
    });
    expect(
      pushed.grants.find((grant) => grant.role === "platform-admin"),
    ).not.toHaveProperty("scope");
  });
});

type Input = Parameters<typeof runCloud>[0];

const IO: CliIo = { stdout: () => undefined, stderr: () => undefined };
const CONFIG: PermDockConfig = {
  permissions: "./src/permissions.ts",
  policy: "./src/policy.ts",
  collect: { srcPath: ["./src"] },
};
const ENV = {
  PERMDOCK_CLOUD_URL: "https://cloud.permdock.test",
  PERMDOCK_CLOUD_KEY: "key",
};

function push(cwd: string, overrides: Partial<Input> = {}) {
  return runCloud({
    cwd,
    config: CONFIG,
    url: undefined,
    dryRun: false,
    json: false,
    env: ENV,
    now: NOW,
    io: IO,
    ...overrides,
  });
}

describe("runCloud", () => {
  it("passes on a catalog that cannot be built", async () => {
    expect(await push(tempDir(), { config: {} })).toEqual({
      code: 2,
      output:
        "usage: set permissions in permdock.config.ts or pass a definePermissions module",
    });
  });

  it("describes a dry run in text, preferring --url and --project", async () => {
    const result = await push(FIXTURE, {
      dryRun: true,
      url: "https://flag.permdock.test/",
      project: "staging",
      env: { ...ENV, PERMDOCK_CLOUD_ENV: "ignored", VERCEL_ENV: "ignored" },
    });
    expect(result.code).toBe(0);
    expect(result.output).toMatch(
      /^would push catalog \S+ \(7 permissions, 0 hostable\) to staging$/u,
    );
  });

  it.each([
    [{ PERMDOCK_CLOUD_ENV: "qa", VERCEL_ENV: "preview" }, "qa"],
    [{ PERMDOCK_CLOUD_ENV: "", VERCEL_ENV: "preview" }, "preview"],
    [{}, "production"],
  ] as const)("picks the environment from %j", async (env, expected) => {
    const result = await push(FIXTURE, { dryRun: true, json: true, env });
    // SAFETY: the --json summary printed by `cloud push --dry-run`.
    const summary = JSON.parse(result.output) as {
      readonly environment: string;
    };
    expect(summary.environment).toBe(expected);
  });

  it("summarises a catalog with no policy, roles or plans", async () => {
    const cwd = tempDir();
    mkdirSync(path.join(cwd, "src"));
    writeFileSync(
      path.join(cwd, "src/permissions.ts"),
      `import { definePermissions, resource } from 'permdock';

export const permissions = definePermissions({
  doc: resource({ actions: ['read'] }),
});
`,
    );
    const result = await push(cwd, {
      config: {
        permissions: "./src/permissions.ts",
        collect: { srcPath: ["./src"] },
      },
      dryRun: true,
      json: true,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      permissions: 1,
      hostable: [],
      roles: 0,
      plans: 0,
      grants: 0,
      environment: "production",
      status: "would push",
    });
  });

  it.each([
    [{ PERMDOCK_CLOUD_URL: "https://cloud.permdock.test" }],
    [{ PERMDOCK_CLOUD_URL: "", PERMDOCK_CLOUD_KEY: "" }],
  ])("needs a key or a login (%j)", async (env) => {
    await expect(
      push(FIXTURE, {
        env: { ...env, XDG_CONFIG_HOME: tempDir() },
        io: {
          ...IO,
          fetch: () => Promise.resolve(new Response(null, { status: 404 })),
        },
      }),
    ).rejects.toMatchObject({
      kind: "action",
      code: "auth_required",
      message:
        "permdock cloud push needs PERMDOCK_CLOUD_KEY in the environment, or a login from permdock login --scope catalog:write",
    });
  });

  it("pushes to the platform issuer without PERMDOCK_CLOUD_URL", async () => {
    const urls: string[] = [];
    const io: CliIo = {
      ...IO,
      fetch: (input) => {
        urls.push(String(input));
        return Promise.resolve(new Response(null, { status: 201 }));
      },
    };
    expect(
      (await push(FIXTURE, { env: { PERMDOCK_CLOUD_KEY: "key" }, io })).code,
    ).toBe(0);
    expect(urls).toEqual([
      "https://permdock.com/api/v1/environments/production/catalog",
    ]);
  });

  it("posts through the global fetch and omits the policy without one", async () => {
    const cwd = tempDir();
    mkdirSync(path.join(cwd, "src"));
    writeFileSync(
      path.join(cwd, "src/permissions.ts"),
      `import { definePermissions, resource } from 'permdock';

export const permissions = definePermissions({
  doc: resource({ actions: ['read'] }),
});
`,
    );
    const bodies: unknown[] = [];
    const fetchStub = vi.fn<typeof fetch>((_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(new Response(null, { status: 201 }));
    });
    vi.stubGlobal("fetch", fetchStub);
    const result = await push(cwd, {
      config: {
        permissions: "./src/permissions.ts",
        collect: { srcPath: ["./src"] },
      },
      project: "a b",
    });
    expect(result.code).toBe(0);
    expect(result.output).toMatch(
      /^pushed catalog \S+ \(1 permissions, 0 hostable\) to a b$/u,
    );
    expect(fetchStub.mock.calls[0]?.[0]).toBe(
      "https://cloud.permdock.test/v1/environments/a%20b/catalog",
    );
    expect(bodies).toEqual([
      {
        fingerprint: expect.any(String),
        catalog: expect.any(Object),
        permdockVersion: expect.stringMatching(/^\d+\.\d+\.\d+/u),
      },
    ]);
  });

  it.each([
    [new Error("ECONNREFUSED"), "PermDock Cloud unreachable: ECONNREFUSED"],
    ["socket hang up", "PermDock Cloud unreachable: socket hang up"],
  ])("reports an unreachable Cloud (%s)", async (thrown, output) => {
    const io: CliIo = {
      ...IO,
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a fetch may reject with a non-Error
      fetch: () => Promise.reject(thrown),
    };
    await expect(push(FIXTURE, { io })).rejects.toMatchObject({
      kind: "unavailable",
      code: "network_error",
      message: output,
    });
  });

  it("asks for a write credential when the Cloud answers 401", async () => {
    const io: CliIo = {
      ...IO,
      fetch: () => Promise.resolve(new Response(null, { status: 401 })),
    };
    await expect(push(FIXTURE, { io })).rejects.toMatchObject({
      kind: "action",
      code: "auth_required",
      message:
        "PermDock Cloud rejected the PERMDOCK_CLOUD_KEY for cloud push (HTTP 401)",
    });
  });

  it("reports a rejected catalog with its status", async () => {
    const io: CliIo = {
      ...IO,
      fetch: () => Promise.resolve(new Response(null, { status: 422 })),
    };
    expect(await push(FIXTURE, { io })).toEqual({
      code: 1,
      output: "PermDock Cloud rejected the catalog: HTTP 422",
    });
  });

  it("sends the permdock-cli user agent", async () => {
    const seen: (string | null)[] = [];
    const io: CliIo = {
      ...IO,
      fetch: (_input, init) => {
        seen.push(new Headers(init?.headers).get("user-agent"));
        return Promise.resolve(new Response(null, { status: 201 }));
      },
    };
    expect((await push(FIXTURE, { io })).code).toBe(0);
    expect(seen).toEqual([
      expect.stringMatching(/^permdock-cli\/\S+ node\/\S+ \S+$/u),
    ]);
  });
});
