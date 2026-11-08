import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";
import { jsonData } from "./envelope.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, "../../tmp");
const temps: string[] = [];

const OPERATIONS = {
  "/orgs/{orgId}/posts": {
    get: {
      operationId: "listPosts",
      tags: ["posts"],
      "x-permdock-permissions": ["post.list"],
    },
    post: {
      operationId: "createPost",
      tags: ["posts"],
      "x-permdock-permissions": ["post.create"],
    },
  },
  "/orgs/{orgId}/posts/{id}": {
    delete: {
      operationId: "deletePost",
      tags: ["posts"],
      "x-authorization": { permission: "post.delete", check: "handler" },
    },
  },
  "/health": { get: { operationId: "health", security: [] } },
  "/me": {
    get: { operationId: "me", "x-permdock-permissions": ["post.read"] },
  },
};

function workdir(paths: Record<string, unknown> = OPERATIONS): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, "annotate-doc-"));
  temps.push(dir);
  cpSync(
    join(HERE, "fixtures/mini-app/src/permissions.ts"),
    join(dir, "permissions.ts"),
  );
  writeFileSync(
    join(dir, "openapi.json"),
    JSON.stringify({
      openapi: "3.2.0",
      info: { title: "t", version: "1" },
      paths,
    }),
  );
  return dir;
}

function annotate(dir: string, ...flags: string[]) {
  return run(
    [
      "openapi",
      "annotate",
      "--doc",
      "openapi.json",
      "--permissions",
      "permissions.ts",
      "--out",
      "operations.ts",
      ...flags,
    ],
    { cwd: dir },
  );
}

describe("openapi annotate --doc", () => {
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the map with operationIds, groups and tenant parameters", async () => {
    const dir = workdir();
    const result = await annotate(dir, "--tenant-path", "orgId");
    expect(result.code).toBe(0);
    const text = readFileSync(join(dir, "operations.ts"), "utf8");
    expect(text).toContain(
      '"GET /orgs/{orgId}/posts": { operationId: "listPosts", permission: permissions.post.list }',
    );
    expect(text).toContain('enforcement: "handler"');
    expect(text).not.toContain("/health");
    expect(text).toContain('"posts": [');
    expect(text).toContain('"POST /orgs/{orgId}/posts": "orgId"');
    expect(text).not.toContain('"GET /me": "orgId"');
    expect(result.stdout).toContain("warning  operation-no-tenant");
  });

  it("groups by first tag, then first path segment", async () => {
    const dir = workdir();
    const result = await run(
      [
        "openapi",
        "annotate",
        "--doc",
        "openapi.json",
        "--permissions",
        "permissions.ts",
        "--out",
        "operations.ts",
        "--json",
      ],
      { cwd: dir },
    );
    const data = jsonData(result.stdout);
    expect(data.groups).toStrictEqual({
      me: ["GET /me"],
      posts: [
        "GET /orgs/{orgId}/posts",
        "POST /orgs/{orgId}/posts",
        "DELETE /orgs/{orgId}/posts/{id}",
      ],
    });
    expect(data.skipped).toStrictEqual(["GET /health"]);
  });

  it("refuses unknown keys, duplicates ids and writes nothing", async () => {
    const dir = workdir({
      "/a": {
        get: { operationId: "same", "x-permdock-permissions": ["post.nope"] },
      },
      "/b": {
        get: { operationId: "same", "x-permdock-permissions": ["post.read"] },
        post: { operationId: "other" },
      },
    });
    const result = await annotate(dir);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("operation-unknown-permission");
    expect(result.stdout).toContain("'post.nope'");
    expect(result.stdout).toContain("operation-id-duplicate");
    expect(result.stdout).toContain("operation-no-permission");
    expect(() => readFileSync(join(dir, "operations.ts"))).toThrow("ENOENT");
  });

  it("warns on a missing operationId and leaves the file with --check", async () => {
    const dir = workdir({
      "/p": { get: { "x-permdock-permissions": ["post.list"] } },
    });
    const stale = await annotate(dir, "--check");
    expect(stale.code).toBe(1);
    expect((await annotate(dir, "--dry-run")).stdout).toContain(
      "would write operations.ts",
    );
    expect(() => readFileSync(join(dir, "operations.ts"))).toThrow("ENOENT");
    const written = await annotate(dir);
    expect(written.code).toBe(0);
    expect(written.stdout).toContain("operation-id-missing");
    expect((await annotate(dir, "--check")).code).toBe(0);
  });

  it("reports usage errors as problems", async () => {
    const dir = workdir();
    const both = await run(
      ["openapi", "annotate", "--doc", "a", "--routes", "b", "--json"],
      { cwd: dir },
    );
    expect(both.code).toBe(2);
    const tenant = await annotate(dir, "--tenant-path", "a/b", "--json");
    expect(tenant.code).toBe(2);
    expect(jsonData(tenant.stdout)).toMatchObject({ code: "invalid_value" });
    const none = await run(
      ["openapi", "annotate", "--doc", "openapi.json", "--json"],
      { cwd: dir },
    );
    expect(none.code).toBe(3);
    expect(jsonData(none.stdout)).toMatchObject({ code: "input_required" });
  });

  it("groups by path segment or root, skips non-operations and reads a missing or invalid document", async () => {
    const dir = workdir({
      "/widgets/{id}": {
        parameters: [],
        get: {
          operationId: "getWidget",
          "x-permdock-permissions": ["post.read"],
        },
        trace: { "x-permdock-permissions": ["post.read"] },
      },
      "/{only}": {
        get: { operationId: "only", "x-permdock-permissions": ["post.read"] },
      },
      "/ignored": "not an object",
    });
    const result = await annotate(dir);
    expect(result.code).toBe(0);
    const text = readFileSync(join(dir, "operations.ts"), "utf8");
    expect(text).toContain('"widgets": [');
    expect(text).toContain('"root": [');
    const missing = await run(
      [
        "openapi",
        "annotate",
        "--doc",
        "nope.json",
        "--permissions",
        "permissions.ts",
        "--json",
      ],
      { cwd: dir },
    );
    expect(missing.code).toBe(2);
    writeFileSync(join(dir, "bad.yaml"), "- just\n- a list\n");
    const bad = await run(
      [
        "openapi",
        "annotate",
        "--doc",
        "bad.yaml",
        "--permissions",
        "permissions.ts",
        "--json",
      ],
      { cwd: dir },
    );
    expect(bad.code).toBe(2);
    writeFileSync(join(dir, "broken.json"), "{ not: [valid");
    const broken = await run(
      [
        "openapi",
        "annotate",
        "--doc",
        "broken.json",
        "--permissions",
        "permissions.ts",
        "--json",
      ],
      { cwd: dir },
    );
    expect(broken.code).toBe(2);
  });
});
