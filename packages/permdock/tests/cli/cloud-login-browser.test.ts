import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../../src/cli/core/run.ts";

interface Spawned {
  readonly calls: (readonly [string, readonly string[]])[];
  fail: boolean;
}

const spawned = vi.hoisted((): Spawned => ({ calls: [], fail: false }));

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: readonly string[]) => {
    if (spawned.fail) {
      throw new Error("ENOENT");
    }
    spawned.calls.push([command, args]);
    return { on: () => undefined, unref: () => undefined };
  },
}));

// Credentials go to the XDG_CONFIG_HOME file, never the developer's keychain.
vi.mock("@napi-rs/keyring", () => {
  throw new Error("@napi-rs/keyring is not installed");
});

const ISSUER = "https://cloud.test/api";
const COMPLETE = "https://cloud.test/device?user_code=ABCD-EFGH";
const platform = Object.getOwnPropertyDescriptor(process, "platform");
const homes: string[] = [];

afterEach(() => {
  spawned.calls.length = 0;
  spawned.fail = false;
  if (platform !== undefined) {
    Object.defineProperty(process, "platform", platform);
  }
});

afterAll(() => {
  for (const dir of homes) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "permdock-browser-"));
  homes.push(dir);
  return dir;
}

const cloud: typeof fetch = async (input, init) => {
  await Promise.resolve();
  const request = new Request(input, init);
  switch (new URL(request.url).pathname) {
    case "/.well-known/oauth-authorization-server/api": {
      return Response.json({
        issuer: ISSUER,
        device_authorization_endpoint: `${ISSUER}/oauth/device_authorization`,
        token_endpoint: `${ISSUER}/oauth/token`,
      });
    }
    case "/api/oauth/device_authorization": {
      return Response.json({
        device_code: "dc",
        user_code: "ABCD-EFGH",
        verification_uri: "https://cloud.test/device",
        verification_uri_complete: COMPLETE,
        expires_in: 60,
        interval: 0,
      });
    }
    case "/api/oauth/token": {
      return Response.json({ access_token: "at_1", scope: "projects:read" });
    }
    default: {
      return new Response(null, { status: 404 });
    }
  }
};

async function login() {
  return run(["login"], {
    cwd: home(),
    io: {
      stdout: () => undefined,
      stderr: () => undefined,
      interactive: true,
      fetch: cloud,
      env: { PERMDOCK_CLOUD_URL: ISSUER, XDG_CONFIG_HOME: home() },
    },
  });
}

describe("permdock login in an interactive terminal", () => {
  it.each([
    ["darwin", "open", [COMPLETE]],
    ["win32", "cmd", ["/c", "start", "", COMPLETE]],
    ["linux", "xdg-open", [COMPLETE]],
  ] as const)("opens the browser on %s", async (name, command, args) => {
    Object.defineProperty(process, "platform", { value: name });
    const result = await login();
    expect(result.code).toBe(0);
    expect(spawned.calls).toStrictEqual([[command, args]]);
  });

  it("still logs in when no browser launcher exists", async () => {
    spawned.fail = true;
    const result = await login();
    expect(result.code).toBe(0);
  });
});
