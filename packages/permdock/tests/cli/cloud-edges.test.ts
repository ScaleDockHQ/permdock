import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { CatalogDocument } from "../../src/catalog/types.ts";
import type { CliIo } from "../../src/cli/types.ts";
import type { StoredCredential } from "../../src/terminal/types.ts";

import { issuerMetadata } from "../../src/cli/cloud/issuer.ts";
import { runLoopbackFlow } from "../../src/cli/cloud/loopback.ts";
import { run } from "../../src/cli/core/run.ts";
import { cliVersion } from "../../src/cli/core/version.ts";
import { catalogFingerprint } from "../../src/core/catalog-fingerprint.ts";
import {
  readCredentials,
  writeCredentials,
} from "../../src/terminal/storage.ts";
import { jsonData } from "./envelope.ts";
import { SOURCES, generate, removeHookProjects } from "./supabase-hook-kit.ts";

// Credentials go to the XDG_CONFIG_HOME file, never the developer's keychain.
// oxlint-disable-next-line vitest/prefer-import-in-mock -- an optional peer; import() makes Knip count it as a dependency
vi.mock("@napi-rs/keyring", () => {
  throw new Error("@napi-rs/keyring is not installed");
});

describe("cloud edges", () => {
  afterEach(removeHookProjects);

  const homes: string[] = [];

  afterAll(() => {
    for (const dir of homes) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const ISSUER = "https://cloud.test/api";
  const METADATA_PATH = "/.well-known/oauth-authorization-server/api";
  const POLICY_PATH = "/api/v1/projects/prj_1/policy";
  const NOW = new Date("2026-10-18T09:00:00.000Z");
  const NOW_SECONDS = NOW.getTime() / 1000;

  const CATALOG: CatalogDocument = {
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
  const FINGERPRINT = catalogFingerprint(CATALOG);

  type Route = (request: Request) => Response | Promise<Response>;

  /** A Cloud that answers `METHOD /path` routes and 404 elsewhere. */
  function stubCloud(routes: Readonly<Record<string, Route>>): typeof fetch {
    return async (input, init) => {
      const request = new Request(input, init);
      const route =
        routes[`${request.method} ${new URL(request.url).pathname}`];
      const response =
        route === undefined
          ? new Response(null, { status: 404 })
          : await route(request);
      return response;
    };
  }

  function metadata(fields: Readonly<Record<string, string>> = {}): Route {
    return () =>
      Response.json({
        issuer: ISSUER,
        token_endpoint: `${ISSUER}/oauth/token`,
        revocation_endpoint: `${ISSUER}/oauth/revoke`,
        ...fields,
      });
  }

  function projectPolicy(
    fields: Readonly<Record<string, unknown>> = {},
  ): Route {
    return () =>
      Response.json({
        v: 1,
        project: "prj_1",
        version: 3,
        fingerprint: FINGERPRINT,
        permdockVersion: cliVersion(),
        catalog: CATALOG,
        ...fields,
      });
  }

  function home(): string {
    const dir = mkdtempSync(join(tmpdir(), "permdock-edges-"));
    homes.push(dir);
    return dir;
  }

  function io(
    fetchFn: typeof fetch,
    env: Readonly<Record<string, string>>,
    stderr: (text: string) => void = () => undefined,
  ): CliIo {
    return {
      stdout: () => undefined,
      stderr,
      now: () => NOW,
      fetch: fetchFn,
      env: { PERMDOCK_CLOUD_URL: ISSUER, ...env },
    };
  }

  const TOKEN = { PERMDOCK_CLOUD_TOKEN: "pt_read" };

  async function pull(
    fetchFn: typeof fetch,
    args: readonly string[] = ["--project", "prj_1"],
    env: Readonly<Record<string, string>> = TOKEN,
    stderr?: (text: string) => void,
  ) {
    const { cwd } = await generate(`{ memberships: [${SOURCES}] }`);
    const result = await run(["cloud", "pull", ...args], {
      cwd,
      io: io(fetchFn, env, stderr),
    });
    return { cwd, ...result };
  }

  function login(
    config: string,
    credential: StoredCredential,
  ): Readonly<Record<string, string>> {
    writeCredentials({ service: "permdock" }, ISSUER, credential, {
      env: { XDG_CONFIG_HOME: config },
    });
    return { XDG_CONFIG_HOME: config };
  }

  describe("permdock cloud pull against a failing Cloud", () => {
    it("reports an unreachable Cloud as cli-unavailable", async () => {
      const result = await pull(
        () => Promise.reject(new Error("ECONNREFUSED")),
        ["--project", "prj_1", "--json"],
      );
      expect(result.code).toBe(1);
      expect(jsonData(result.stdout)).toMatchObject({
        type: "https://permdock.com/docs/cli/errors#network_error",
      });
    });

    it.each([
      [() => new Response("<html>", { status: 200 }), /not JSON/u],
      [
        () =>
          new Response(null, { status: 429, headers: { "retry-after": "7" } }),
        /retry after 7 seconds/u,
      ],
      [() => new Response(null, { status: 429 }), /retry after a while/u],
      [() => new Response("oops", { status: 500 }), /HTTP 500/u],
      [projectPolicy({ v: 2 }), /not v1/u],
      [projectPolicy({ manifest: "text" }), /not v1/u],
      [projectPolicy({ catalog: {} }), /invalid catalog/u],
      [projectPolicy({ manifest: {} }), /invalid manifest/u],
    ] as const)("answers %# with exit 1", async (route, message) => {
      const result = await pull(stubCloud({ [`GET ${POLICY_PATH}`]: route }));
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(message);
    });

    it("asks for a login with exit 3 when the Cloud rejects the credential", async () => {
      const result = await pull(
        stubCloud({
          [`GET ${POLICY_PATH}`]: () => new Response(null, { status: 401 }),
        }),
      );
      expect(result.code).toBe(3);
      expect(result.stderr).toContain(
        "PermDock Cloud rejected the credential (HTTP 401)",
      );
      expect(result.stderr).toContain("permdock login");
    });

    it("keeps the Cloud's problem type under --json", async () => {
      const result = await pull(
        stubCloud({
          [`GET ${POLICY_PATH}`]: () =>
            Response.json(
              { type: "https://permdock.com/problems/maintenance" },
              { status: 503 },
            ),
        }),
        ["--project", "prj_1", "--json"],
      );
      expect(jsonData(result.stdout)).toMatchObject({
        type: "https://permdock.com/problems/maintenance",
        status: 503,
      });
    });

    it("removes a catalog it wrote when the fingerprint does not match", async () => {
      const result = await pull(
        stubCloud({
          [`GET ${POLICY_PATH}`]: projectPolicy({
            catalog: { ...CATALOG, fingerprint: FINGERPRINT },
            fingerprint: "sha-256:other",
          }),
        }),
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("restored the previous files");
      expect(existsSync(join(result.cwd, "permissions.catalog.json"))).toBe(
        false,
      );
    });

    it("warns about another permdock version and a push without a manifest", async () => {
      const warnings: string[] = [];
      const result = await pull(
        stubCloud({
          [`GET ${POLICY_PATH}`]: projectPolicy({ permdockVersion: "0.0.1" }),
        }),
        ["--project", "prj_1"],
        TOKEN,
        (text) => {
          warnings.push(text);
        },
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/^pulled prj_1 version 3: wrote /u);
      expect(warnings.join("\n")).toMatch(
        /permdock@0\.0\.1[\s\S]*no manifest/u,
      );
    });
  });

  describe("the project a PERMDOCK_CLOUD_TOKEN reads", () => {
    const list =
      (body: unknown, status = 200): Route =>
      () =>
        Response.json(body, { status });

    it("is the one project GET /v1/projects lists", async () => {
      const result = await pull(
        stubCloud({
          "GET /api/v1/projects": list({
            items: [{ id: "prj_1", name: "Acme" }, { name: "no id" }],
          }),
          [`GET ${POLICY_PATH}`]: projectPolicy(),
        }),
        ["--json"],
      );
      expect(result.code).toBe(0);
      expect(jsonData(result.stdout)).toMatchObject({ project: "prj_1" });
    });

    it.each([
      [{ items: [{ id: "a" }, { id: "b" }] }, 200, 2, /reads 2 projects/u],
      [{ items: "none" }, 200, 2, /reads 0 projects/u],
      [{}, 401, 3, /rejected the credential/u],
    ] as const)("refuses %j", async (body, status, code, message) => {
      const result = await pull(
        stubCloud({ "GET /api/v1/projects": list(body, status) }),
        [],
      );
      expect(result.code).toBe(code);
      expect(result.stderr).toMatch(message);
    });

    it("is required with a login", async () => {
      const result = await pull(
        stubCloud({}),
        [],
        login(home(), { access_token: "at_1" }),
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--project");
    });
  });

  describe("an expired login", () => {
    const expired: StoredCredential = {
      access_token: "at_old",
      refresh_token: "rt_1",
      expires_at: NOW_SECONDS - 60,
      scope: "projects:read policy:read",
    };

    it("is refreshed, keeping the refresh token and scope the answer omits", async () => {
      const config = home();
      const env = login(config, expired);
      const result = await pull(
        stubCloud({
          [`GET ${METADATA_PATH}`]: metadata(),
          "POST /api/oauth/token": () =>
            Response.json({ access_token: "at_new", expires_in: 3600 }),
          [`GET ${POLICY_PATH}`]: (request) =>
            request.headers.get("authorization") === "Bearer at_new"
              ? projectPolicy()(request)
              : new Response(null, { status: 401 }),
        }),
        ["--project", "prj_1"],
        env,
      );
      expect(result.code).toBe(0);
      expect(
        readCredentials({ service: "permdock" }, ISSUER, { env }),
      ).toMatchObject({
        access_token: "at_new",
        refresh_token: "rt_1",
        scope: "projects:read policy:read",
      });
    });

    it("asks for a login with exit 3 when the refresh is refused", async () => {
      const result = await pull(
        stubCloud({
          [`GET ${METADATA_PATH}`]: metadata(),
          "POST /api/oauth/token": () =>
            Response.json({ error: "invalid_grant" }, { status: 400 }),
        }),
        ["--project", "prj_1"],
        login(home(), expired),
      );
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("has expired");
    });

    it("asks for a login with exit 3 when the issuer publishes no metadata", async () => {
      const result = await pull(
        stubCloud({}),
        ["--project", "prj_1"],
        login(home(), expired),
      );
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("has expired");
    });
  });

  describe("permdock cloud push without PERMDOCK_CLOUD_KEY", () => {
    async function push(
      env: Readonly<Record<string, string>>,
      args: readonly string[] = [],
    ) {
      const { cwd } = await generate(`{ memberships: [${SOURCES}] }`);
      return run(["cloud", "push", ...args], {
        cwd,
        io: io(stubCloud({ [`GET ${METADATA_PATH}`]: metadata() }), env),
      });
    }

    it("needs catalog:write on the login", async () => {
      const result = await push(
        login(home(), { access_token: "at_1", scope: "projects:read" }),
      );
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("catalog:write");
    });

    it("asks for a login with exit 3 on an expired login", async () => {
      const result = await push(
        login(home(), { access_token: "at_1", expires_at: NOW_SECONDS - 60 }),
      );
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("permdock login --scope catalog:write");
    });

    it("refuses a --manifest that is not a manifest", async () => {
      const { cwd } = await generate(`{ memberships: [${SOURCES}] }`);
      writeFileSync(join(cwd, "bad.json"), "{}");
      const result = await run(["cloud", "push", "--manifest", "bad.json"], {
        cwd,
        io: io(stubCloud({}), {}),
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("not a valid manifest");
    });

    it("points --environment at --project", async () => {
      const result = await push({}, ["--project", "a", "--environment", "b"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--environment is --project");
    });
  });

  describe("permdock rls generate --project against a failing Cloud", () => {
    async function generateRls(route: Route, json = false) {
      const { cwd } = await generate(`{ memberships: [${SOURCES}] }`);
      return run(
        [
          "rls",
          "generate",
          "--project",
          "prj_1",
          "--out",
          "hosted.sql",
          ...(json ? ["--json"] : []),
        ],
        { cwd, io: io(stubCloud({ [`GET ${POLICY_PATH}`]: route }), TOKEN) },
      );
    }

    it("passes a fetch failure through", async () => {
      const result = await generateRls(
        () => new Response(null, { status: 401 }),
      );
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("rejected the credential");
    });

    it("refuses a push that carried no policy, as Problem Details under --json", async () => {
      const text = await generateRls(projectPolicy());
      expect(text.code).toBe(1);
      expect(text.stdout).toContain("no policy");
      const json = await generateRls(projectPolicy(), true);
      expect(jsonData(json.stdout)).toMatchObject({
        type: "https://permdock.com/problems/policy-not-published",
      });
    });

    it("refuses a pushed policy that does not rebuild", async () => {
      const result = await generateRls(
        projectPolicy({ policy: { v: 1, grants: [{ permission: "nope" }] } }),
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("does not rebuild");
    });
  });

  describe("permdock login and logout edges", () => {
    const device: Readonly<Record<string, Route>> = {
      [`GET ${METADATA_PATH}`]: metadata({
        device_authorization_endpoint: `${ISSUER}/oauth/device_authorization`,
      }),
      "POST /api/oauth/device_authorization": () =>
        Response.json({
          device_code: "dc",
          user_code: "ABCD-EFGH",
          verification_uri: "https://cloud.test/device",
          expires_in: 60,
          interval: 0,
        }),
    };

    it("stores the requested scope when the token answer names none, outside any repository", async () => {
      const env = { XDG_CONFIG_HOME: home() };
      const result = await run(["login", "--no-open"], {
        cwd: home(),
        io: io(
          stubCloud({
            ...device,
            "POST /api/oauth/token": () =>
              Response.json({ access_token: "at_1", token_type: "Bearer" }),
          }),
          env,
        ),
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("(projects:read policy:read)");
    });

    it("fails when the issuer denies the device code", async () => {
      const result = await run(["login"], {
        cwd: home(),
        io: io(
          stubCloud({
            ...device,
            "POST /api/oauth/token": () =>
              Response.json({ error: "access_denied" }, { status: 400 }),
          }),
          { XDG_CONFIG_HOME: home() },
        ),
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("did not issue a token");
    });

    it("fails when the issuer offers neither flow", async () => {
      const result = await run(["login"], {
        cwd: home(),
        io: io(
          stubCloud({
            [`GET ${METADATA_PATH}`]: () => Response.json({ issuer: ISSUER }),
          }),
          { XDG_CONFIG_HOME: home() },
        ),
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("neither the device flow");
    });

    it.each([
      [
        "no revocation endpoint",
        { [`GET ${METADATA_PATH}`]: () => Response.json({ issuer: ISSUER }) },
      ],
      [
        "a revocation endpoint that is unreachable",
        {
          [`GET ${METADATA_PATH}`]: metadata(),
          "POST /api/oauth/revoke": () => Promise.reject(new Error("reset")),
        },
      ],
    ] as const)("deletes the login with %s", async (_name, routes) => {
      const env = login(home(), { access_token: "at_1" });
      const result = await run(["logout"], {
        cwd: home(),
        io: io(stubCloud(routes), env),
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("the token was not revoked");
      expect(readCredentials({ service: "permdock" }, ISSUER, { env })).toBe(
        null,
      );
    });
  });

  describe("issuer metadata", () => {
    it("drops an endpoint that is not https on a remote issuer", async () => {
      const found = await issuerMetadata(ISSUER, {
        fetch: stubCloud({
          [`GET ${METADATA_PATH}`]: metadata({
            authorization_endpoint: "http://cloud.test/api/oauth/authorize",
            device_authorization_endpoint: "not a url",
          }),
        }),
      });
      expect(found).toStrictEqual({
        issuer: ISSUER,
        tokenEndpoint: `${ISSUER}/oauth/token`,
        revocationEndpoint: `${ISSUER}/oauth/revoke`,
      });
    });
  });

  describe("the RFC 8252 loopback flow", () => {
    async function loopback(
      browse: (authorize: URL) => Promise<unknown>,
      tokenFetch: typeof fetch = () =>
        Promise.resolve(Response.json({ access_token: "at_1" })),
      timeoutMs = 5000,
    ) {
      let opened: Promise<unknown> = Promise.resolve();
      const credential = await runLoopbackFlow(
        {
          authorizationEndpoint: `${ISSUER}/oauth/authorize`,
          tokenEndpoint: `${ISSUER}/oauth/token`,
          clientId: "permdock-cli",
          scope: "projects:read",
          timeoutMs,
          write: () => undefined,
          open: (url) => {
            opened = browse(new URL(url));
          },
        },
        { fetch: tokenFetch },
      );
      await opened;
      return credential;
    }

    const callback = (authorize: URL, query: Record<string, string>): URL => {
      const target = new URL(authorize.searchParams.get("redirect_uri") ?? "");
      for (const [name, value] of Object.entries(query)) {
        target.searchParams.set(name, value);
      }
      return target;
    };

    it("answers 404 off the callback path and refuses a callback with another state", async () => {
      const statuses: number[] = [];
      const credential = await loopback(async (authorize) => {
        const redirect = new URL(
          authorize.searchParams.get("redirect_uri") ?? "",
        );
        statuses.push((await fetch(new URL("/favicon.ico", redirect))).status);
        statuses.push(
          (await fetch(callback(authorize, { code: "c", state: "forged" })))
            .status,
        );
      });
      expect(statuses).toStrictEqual([404, 400]);
      expect(credential).toBeNull();
    });

    it("gives up when the browser never comes back", async () => {
      expect(await loopback(() => Promise.resolve(), undefined, 10)).toBeNull();
    });

    it("gives up when the token endpoint is unreachable", async () => {
      const credential = await loopback(
        async (authorize) =>
          fetch(
            callback(authorize, {
              code: "c",
              state: authorize.searchParams.get("state") ?? "",
            }),
          ),
        () => Promise.reject(new Error("reset")),
      );
      expect(credential).toBeNull();
    });
  });
});
