import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { CatalogDocument } from "../../src/catalog/types.ts";

import { run } from "../../src/cli/core/run.ts";
import { referenceCloud } from "../cloud/fixtures/reference-cloud.ts";
import { policy } from "../fixtures/named-scopes.ts";

const secrets = vi.hoisted(() => new Map<string, string>());

// oxlint-disable-next-line vitest/prefer-import-in-mock -- the fake does not match the real module types
vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    readonly #key: string;
    public constructor(service: string, account: string) {
      this.#key = `${service}/${account}`;
    }
    public getPassword(): string | null {
      return secrets.get(this.#key) ?? null;
    }
    public setPassword(value: string): void {
      secrets.set(this.#key, value);
    }
    public deletePassword(): boolean {
      return secrets.delete(this.#key);
    }
  },
}));

const FIXTURE = join(import.meta.dirname, "fixtures/mini-app");
const home = mkdtempSync(join(tmpdir(), "permdock-keyring-"));

describe("cloud keyring", () => {
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const CATALOG: CatalogDocument = {
    $schema: "https://permdock.com/schemas/catalog-v1.json",
    version: 1,
    generatedAt: "2026-10-01T00:00:00.000Z",
    generator: "permdock@0.4.0",
    resources: { post: { id: "id", schema: { type: "object" } } },
    permissions: [],
  };

  describe("permdock login with @napi-rs/keyring installed", () => {
    it("stores the login in the OS keychain and deletes it on logout", async () => {
      const reference = await referenceCloud(policy, CATALOG);
      const io = {
        stdout: () => undefined,
        stderr: () => undefined,
        fetch: reference.fetch,
        env: { PERMDOCK_CLOUD_URL: reference.url, XDG_CONFIG_HOME: home },
      };
      const login = await run(["login"], { cwd: FIXTURE, io });
      expect(login.code).toBe(0);
      expect(login.stdout).toContain("the OS keychain");
      expect(secrets.size).toBe(1);
      expect(existsSync(join(home, "permdock", "credentials.json"))).toBe(
        false,
      );
      const { code } = await run(["logout"], { cwd: FIXTURE, io });
      expect(code).toBe(0);
      expect(secrets.size).toBe(0);
    });
  });
});
