import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileEnsuringDir } from "../files.ts";

/** Cache entries this process understands. An older or newer file is ignored. */
const FORMAT = 1;

export type CacheFile = {
  readonly path: string;
  readonly hash: string;
  readonly plugin: string;
};

export type CacheEntry = {
  readonly format: typeof FORMAT;
  readonly files: readonly CacheFile[];
};

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * `node_modules/.cache/permdock/v1` under `cwd`, unless `override` or
 * `PERMDOCK_CACHE_DIR` names another directory. The `v1` segment is the format;
 * a different segment is never read.
 */
export function cacheDirectory(cwd: string, override?: string): string {
  const root =
    override ??
    process.env["PERMDOCK_CACHE_DIR"] ??
    join(cwd, "node_modules", ".cache", "permdock");
  return join(root, "v1");
}

function entryPath(dir: string, key: string): string {
  return join(dir, key);
}

export function readCache(dir: string, key: string): CacheEntry | undefined {
  const path = entryPath(dir, key);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isEntry(parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function isEntry(value: unknown): value is CacheEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (!("format" in value) || value.format !== FORMAT) {
    return false;
  }
  if (!("files" in value) || !Array.isArray(value.files)) {
    return false;
  }
  for (const item of value.files) {
    if (cacheFile(item) === undefined) {
      return false;
    }
  }
  return true;
}

function cacheFile(value: unknown): CacheFile | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const path: unknown = Reflect.get(value, "path");
  const hash: unknown = Reflect.get(value, "hash");
  const plugin: unknown = Reflect.get(value, "plugin");
  if (
    typeof path !== "string" ||
    typeof hash !== "string" ||
    typeof plugin !== "string"
  ) {
    return undefined;
  }
  return { path, hash, plugin };
}

/** A hit whose recorded hashes still match the files on disk. */
export function cacheHit(cwd: string, entry: CacheEntry): boolean {
  return entry.files.every((file) => {
    const path = join(cwd, file.path);
    if (!existsSync(path)) {
      return false;
    }
    return hashText(readFileSync(path, "utf8")) === file.hash;
  });
}

export function writeCache(
  dir: string,
  key: string,
  files: readonly CacheFile[],
): void {
  const body = `${JSON.stringify({ format: FORMAT, files } satisfies CacheEntry)}\n`;
  writeFileEnsuringDir(entryPath(dir, key), body);
}
