import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { KeyringEntry } from "../../src/terminal/types.ts";

import {
  credentialsPath,
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from "../../src/terminal/storage.ts";

const root = path.join(import.meta.dirname, "../../tmp/terminal-storage");
let counter = 0;

function configDir(): string {
  counter += 1;
  const dir = path.join(root, String(counter));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

class ThrowingConstructor implements KeyringEntry {
  private readonly stored: string | null = null;
  public constructor() {
    throw new Error("no keychain");
  }
  public getPassword(): string | null {
    return this.stored;
  }
  public setPassword(): void {
    throw new Error(String(this.stored));
  }
  public deletePassword(): boolean {
    return this.stored !== null;
  }
}

class GarbageEntry implements KeyringEntry {
  private readonly stored = "{not json";
  public getPassword(): string | null {
    return this.stored;
  }
  public setPassword(): void {
    throw new Error(`read-only: ${this.stored}`);
  }
  public deletePassword(): boolean {
    return this.stored.length === 0;
  }
}

class EmptyEntry implements KeyringEntry {
  private readonly stored: undefined = undefined;
  public getPassword(): undefined {
    return this.stored;
  }
  public setPassword(): void {
    throw new Error(`read-only: ${String(this.stored)}`);
  }
  public deletePassword(): boolean {
    return this.stored === undefined;
  }
}

describe("credentialsPath", () => {
  const home = (): string => "/home/anne";
  const cases: readonly [Parameters<typeof credentialsPath>[1], string][] = [
    [{ configDir: "/cfg" }, path.join("/cfg", "credentials.json")],
    [
      { platform: "linux", env: {}, homedir: home },
      path.join("/home/anne", ".config", "acme", "credentials.json"),
    ],
    [
      { platform: "linux", env: { XDG_CONFIG_HOME: "/xdg" }, homedir: home },
      path.join("/xdg", "acme", "credentials.json"),
    ],
    [
      { platform: "win32", env: {}, homedir: home },
      path.join("/home/anne", "AppData", "Roaming", "acme", "credentials.json"),
    ],
    [
      { platform: "win32", env: { APPDATA: "/appdata" }, homedir: home },
      path.join("/appdata", "acme", "credentials.json"),
    ],
  ];
  it.each(cases)("resolves %j", (runtime, expected) => {
    expect(credentialsPath("acme", runtime)).toBe(expected);
  });

  it("defaults to the process home, env and platform", () => {
    expect(credentialsPath("acme", {}).endsWith("credentials.json")).toBe(true);
  });
});

describe("credential files", () => {
  it("keeps only the string and number fields it knows", () => {
    const runtime = { configDir: configDir() };
    writeFileSync(
      credentialsPath("acme", runtime),
      JSON.stringify({
        profiles: {
          full: {
            access_token: "at",
            refresh_token: "rt",
            expires_at: 9,
            token_type: "Bearer",
          },
          odd: {
            access_token: "at",
            refresh_token: 1,
            expires_at: "9",
            token_type: 2,
          },
          broken: { access_token: 1 },
        },
      }),
      { mode: 0o600 },
    );
    const storage = { service: "acme" };
    expect([
      readCredentials(storage, "full", runtime),
      readCredentials(storage, "odd", runtime),
      readCredentials(storage, "broken", runtime),
      readCredentials(storage, "missing", runtime),
    ]).toEqual([
      {
        access_token: "at",
        refresh_token: "rt",
        expires_at: 9,
        token_type: "Bearer",
      },
      { access_token: "at" },
      null,
      null,
    ]);
  });

  it("reads nothing from a file without profiles or with invalid JSON", () => {
    const storage = { service: "acme" };
    for (const content of ['{"other":1}', "[1]", "{oops"]) {
      const runtime = { configDir: configDir() };
      writeFileSync(credentialsPath("acme", runtime), content, { mode: 0o600 });
      expect(readCredentials(storage, "default", runtime)).toBeNull();
    }
  });

  it("accepts a group-readable file on win32", () => {
    const runtime = { configDir: configDir(), platform: "win32" };
    writeFileSync(
      credentialsPath("acme", runtime),
      JSON.stringify({ profiles: { default: { access_token: "at" } } }),
      { mode: 0o644 },
    );
    expect(readCredentials({ service: "acme" }, "default", runtime)).toEqual({
      access_token: "at",
    });
  });

  it("overwrites a corrupt file and keeps other profiles on delete", () => {
    const runtime = { configDir: configDir() };
    const storage = { service: "acme" };
    const file = credentialsPath("acme", runtime);
    writeFileSync(file, "{oops", { mode: 0o600 });
    writeCredentials(storage, "a", { access_token: "a" }, runtime);
    writeCredentials(storage, "b", { access_token: "b" }, runtime);
    deleteCredentials(storage, "a", runtime);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      profiles: { b: { access_token: "b" } },
    });
    deleteCredentials(storage, "b", runtime);
    expect(existsSync(file)).toBe(false);
  });

  it("starts fresh when the existing file has no profiles", () => {
    const runtime = { configDir: configDir() };
    const file = credentialsPath("acme", runtime);
    writeFileSync(file, '{"version":1}', { mode: 0o600 });
    writeCredentials({ service: "acme" }, "a", { access_token: "a" }, runtime);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      profiles: { a: { access_token: "a" } },
    });
  });

  it("leaves a file without profiles alone on delete", () => {
    const runtime = { configDir: configDir() };
    const file = credentialsPath("acme", runtime);
    writeFileSync(file, '{"version":1}', { mode: 0o600 });
    deleteCredentials({ service: "acme" }, "a", runtime);
    expect(readFileSync(file, "utf8")).toBe('{"version":1}');
  });

  it("does nothing when deleting without a file", () => {
    const runtime = { configDir: configDir() };
    deleteCredentials({ service: "acme" }, "a", runtime);
    expect(existsSync(credentialsPath("acme", runtime))).toBe(false);
  });
});

describe("keyring failures", () => {
  it("uses the file when the keyring constructor throws", () => {
    const runtime = { configDir: configDir() };
    const storage = { service: "acme", keyring: ThrowingConstructor };
    writeCredentials(storage, "default", { access_token: "at" }, runtime);
    expect(readCredentials(storage, "default", runtime)).toEqual({
      access_token: "at",
    });
    deleteCredentials(storage, "default", runtime);
    expect(existsSync(credentialsPath("acme", runtime))).toBe(false);
  });

  it("falls back to the file for an unparseable or empty keychain entry", () => {
    for (const keyring of [GarbageEntry, EmptyEntry]) {
      const runtime = { configDir: configDir() };
      const storage = { service: "acme", keyring };
      writeCredentials(storage, "default", { access_token: "file" }, runtime);
      expect(readCredentials(storage, "default", runtime)).toEqual({
        access_token: "file",
      });
    }
  });
});
