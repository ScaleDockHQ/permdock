import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { CatalogDocument } from "../../src/catalog/types.ts";
import type { CliIo } from "../../src/cli/types.ts";

import { run } from "../../src/cli/core/run.ts";
import { referenceCloud } from "../cloud/fixtures/reference-cloud.ts";
import { policy } from "../fixtures/named-scopes.ts";
import { jsonData } from "./envelope.ts";

// Credentials go to the XDG_CONFIG_HOME file, never the developer's keychain.
vi.mock(import("@napi-rs/keyring"), () => {
  throw new Error("@napi-rs/keyring is not installed");
});

const FIXTURE = join(import.meta.dirname, "fixtures/mini-app");
const TMP = join(import.meta.dirname, "../../tmp");
const temps: string[] = [];

describe("cloud login", () => {
  afterAll(() => {
    for (const dir of temps) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  type Cloud = Awaited<ReturnType<typeof referenceCloud>>;

  /** A config directory outside the repository, as `permdock login` requires. */
  function configHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "permdock-login-"));
    temps.push(dir);
    return dir;
  }

  function io(
    reference: Cloud,
    env: Readonly<Record<string, string>>,
    stderr: (text: string) => void = () => undefined,
    fetchFn: typeof fetch = reference.fetch,
  ): CliIo {
    return {
      stdout: () => undefined,
      stderr,
      fetch: fetchFn,
      env: { PERMDOCK_CLOUD_URL: reference.url, ...env },
    };
  }

  function stored(home: string): Record<string, unknown> {
    return JSON.parse(
      readFileSync(join(home, "permdock", "credentials.json"), "utf8"),
    );
  }

  describe("permdock login", () => {
    it("logs in with the device flow, reads the project and logs out with RFC 7009", async () => {
      const reference = await referenceCloud(policy, CATALOG);
      const home = configHome();
      const env = { XDG_CONFIG_HOME: home };
      const prompts: string[] = [];
      const login = await run(["login", "--json"], {
        cwd: FIXTURE,
        io: io(reference, env, (text) => {
          prompts.push(text);
        }),
      });
      expect(login.code).toBe(0);
      expect(jsonData(login.stdout)).toMatchObject({
        issuer: reference.url,
        scope: "projects:read policy:read",
      });
      expect(prompts.join("")).toContain("PERM-DOCK");
      expect(JSON.stringify(stored(home))).toContain(reference.url);

      const listed = await run(
        ["cloud", "pull", "--project", "test", "--json"],
        { cwd: configHome(), io: io(reference, env) },
      );
      expect(listed.code).toBe(0);

      const logout = await run(["logout", "--json"], {
        cwd: FIXTURE,
        io: io(reference, env),
      });
      expect(jsonData(logout.stdout)).toMatchObject({ status: "revoked" });
      expect([...reference.platform.revoked]).toStrictEqual([
        expect.stringMatching(/^rt_/u),
      ]);
      const again = await run(["logout"], {
        cwd: FIXTURE,
        io: io(reference, env),
      });
      expect(again.stdout).toContain("not logged in");
    });

    it("asks for catalog:write with --write and pushes with the login", async () => {
      const reference = await referenceCloud(policy, CATALOG);
      const env = { XDG_CONFIG_HOME: configHome() };
      const login = await run(["login", "--scope", "catalog:write"], {
        cwd: FIXTURE,
        io: io(reference, env),
      });
      expect(login.code).toBe(0);
      expect(login.stdout).toContain("catalog:write");
      const push = await run(["cloud", "push", "--project", "test"], {
        cwd: FIXTURE,
        io: io(reference, env),
      });
      expect(push.stdout).toMatch(/^pushed catalog /u);
      expect(push.code).toBe(0);
    });

    it("falls back to the RFC 8252 loopback redirect with PKCE", async () => {
      const reference = await referenceCloud(policy, CATALOG);
      const env = { XDG_CONFIG_HOME: configHome() };
      const browser: Promise<unknown>[] = [];
      const follow = (text: string): void => {
        const match = /Open (\S+) to log in/u.exec(text);
        if (match?.[1] === undefined) {
          return;
        }
        browser.push(
          reference
            .fetch(match[1], { redirect: "manual" })
            .then((response) => fetch(response.headers.get("location") ?? ""))
            .then((response) => response.text()),
        );
      };
      const login = await run(["login", "--loopback"], {
        cwd: FIXTURE,
        io: io(reference, env, follow),
      });
      await Promise.all(browser);
      expect(browser).toHaveLength(1);
      expect(login.code).toBe(0);
      expect(stored(env.XDG_CONFIG_HOME)).toBeTypeOf("object");
    });

    it("refuses to store credentials inside the repository", async () => {
      const reference = await referenceCloud(policy, CATALOG);
      mkdirSync(TMP, { recursive: true });
      const inside = mkdtempSync(join(TMP, "login-"));
      temps.push(inside);
      const login = await run(["login"], {
        cwd: FIXTURE,
        io: io(reference, { XDG_CONFIG_HOME: inside }),
      });
      expect(login.code).toBe(2);
      expect(login.stderr).toContain("inside the repository");
      expect(existsSync(join(inside, "permdock"))).toBe(false);
    });

    it("fails without RFC 8414 metadata for the issuer", async () => {
      const reference = await referenceCloud(policy, CATALOG);
      const login = await run(["login"], {
        cwd: FIXTURE,
        io: io(
          reference,
          { XDG_CONFIG_HOME: configHome() },
          () => undefined,
          () => Promise.resolve(new Response(null, { status: 404 })),
        ),
      });
      expect(login.code).toBe(1);
      expect(login.stdout).toContain("RFC 8414");
    });
  });

  describe("permdock whoami", () => {
    it("asks for a login when there is no credential", async () => {
      const reference = await referenceCloud(policy, CATALOG);
      const result = await run(["whoami", "--json"], {
        cwd: FIXTURE,
        io: io(reference, { XDG_CONFIG_HOME: configHome() }),
      });
      expect(result.code).toBe(3);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "action_required",
        error: { code: "auth_required" },
        next: [{ command: "permdock login" }],
      });
    });

    it("names an environment credential without its value", async () => {
      const reference = await referenceCloud(policy, CATALOG);
      const result = await run(["whoami"], {
        cwd: FIXTURE,
        io: io(reference, { PERMDOCK_CLOUD_KEY: "pdk_secret" }),
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(
        `${reference.url}: PERMDOCK_CLOUD_KEY from the environment\n`,
      );
    });

    it("reports the stored login's scopes and expiry", async () => {
      const reference = await referenceCloud(policy, CATALOG);
      const env = { XDG_CONFIG_HOME: configHome() };
      expect(
        (await run(["login"], { cwd: FIXTURE, io: io(reference, env) })).code,
      ).toBe(0);
      const json = await run(["whoami", "--json"], {
        cwd: FIXTURE,
        io: io(reference, env),
      });
      expect(jsonData(json.stdout)).toMatchObject({
        issuer: reference.url,
        source: "login",
        scopes: ["projects:read", "policy:read"],
        expired: false,
      });
      const text = await run(["whoami"], {
        cwd: FIXTURE,
        io: io(reference, env),
      });
      expect(text.stdout).toBe(
        `${reference.url}: logged in (projects:read policy:read)\n`,
      );
    });

    it("says when a login without a refresh token has expired", async () => {
      const reference = await referenceCloud(policy, CATALOG);
      const env = { XDG_CONFIG_HOME: configHome() };
      expect(
        (await run(["login"], { cwd: FIXTURE, io: io(reference, env) })).code,
      ).toBe(0);
      const file = join(env.XDG_CONFIG_HOME, "permdock", "credentials.json");
      writeFileSync(
        file,
        JSON.stringify({
          profiles: {
            [reference.url]: { access_token: "at_old", expires_at: 1 },
          },
        }),
      );
      const text = await run(["whoami"], {
        cwd: FIXTURE,
        io: io(reference, env),
      });
      expect(text.stdout).toBe(
        `${reference.url}: logged in (no scopes); the login has expired, run permdock login\n`,
      );
      const json = await run(["whoami", "--json"], {
        cwd: FIXTURE,
        io: io(reference, env),
      });
      expect(jsonData(json.stdout)).toMatchObject({
        scopes: [],
        expiresAt: "1970-01-01T00:00:01.000Z",
        expired: true,
      });
    });

    it("names an environment credential under --json, and logout says when nobody is logged in", async () => {
      const reference = await referenceCloud(policy, CATALOG);
      const whoami = await run(["whoami", "--json"], {
        cwd: FIXTURE,
        io: io(reference, { PERMDOCK_CLOUD_TOKEN: "pdt_x" }),
      });
      expect(jsonData(whoami.stdout)).toStrictEqual({
        issuer: reference.url,
        source: "PERMDOCK_CLOUD_TOKEN",
      });
      const logout = await run(["logout", "--json"], {
        cwd: FIXTURE,
        io: io(reference, { XDG_CONFIG_HOME: configHome() }),
      });
      expect(jsonData(logout.stdout)).toStrictEqual({
        issuer: reference.url,
        status: "not logged in",
      });
    });
  });
});
