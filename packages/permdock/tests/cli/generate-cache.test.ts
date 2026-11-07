import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  cacheDirectory,
  cacheHit,
  hashText,
  readCache,
  writeCache,
} from "../../src/cli/generate/cache.ts";

const dirs: string[] = [];

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "permdock-cache-"));
  dirs.push(dir);
  return dir;
}

describe("generate cache", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env["PERMDOCK_CACHE_DIR"];
  });

  it("reads a written entry and ignores a missing, stale or malformed file", () => {
    const dir = directory();
    expect(readCache(dir, "echo")).toBeUndefined();
    writeCache(dir, "echo", [
      { path: "echo.txt", hash: "abc", plugin: "echo" },
    ]);
    expect(readCache(dir, "echo")).toStrictEqual({
      format: 1,
      files: [{ path: "echo.txt", hash: "abc", plugin: "echo" }],
    });
    writeFileSync(join(dir, "bad"), "{");
    expect(readCache(dir, "bad")).toBeUndefined();
    for (const body of [
      "null",
      "[]",
      '{"format":2,"files":[]}',
      '{"format":1}',
      '{"format":1,"files":"no"}',
      '{"format":1,"files":[null]}',
      '{"format":1,"files":[{}]}',
      '{"format":1,"files":[{"path":1,"hash":"a","plugin":"p"}]}',
      '{"format":1,"files":[{"path":"a","hash":1,"plugin":"p"}]}',
      '{"format":1,"files":[{"path":"a","hash":"h","plugin":1}]}',
    ]) {
      writeFileSync(join(dir, "shape"), body);
      expect(readCache(dir, "shape")).toBeUndefined();
    }
  });

  it("matches a hit only when every recorded hash is still on disk", () => {
    const cwd = directory();
    writeFileSync(join(cwd, "echo.txt"), "one\n");
    const hash = hashText("one\n");
    const entry = {
      format: 1 as const,
      files: [{ path: "echo.txt", hash, plugin: "echo" }],
    };
    expect(cacheHit(cwd, entry)).toBe(true);
    expect(cacheHit(cwd, { format: 1, files: [] })).toBe(true);
    expect(
      cacheHit(cwd, {
        format: 1,
        files: [{ path: "missing.txt", hash, plugin: "echo" }],
      }),
    ).toBe(false);
    expect(
      cacheHit(cwd, {
        format: 1,
        files: [{ path: "echo.txt", hash: "other", plugin: "echo" }],
      }),
    ).toBe(false);
  });

  it("uses the override directory ahead of PERMDOCK_CACHE_DIR", () => {
    process.env["PERMDOCK_CACHE_DIR"] = "/env-cache";
    expect(cacheDirectory("/app")).toBe("/env-cache/v1");
    expect(cacheDirectory("/app", "/override")).toBe("/override/v1");
    delete process.env["PERMDOCK_CACHE_DIR"];
    expect(cacheDirectory("/app")).toBe("/app/node_modules/.cache/permdock/v1");
  });
});
