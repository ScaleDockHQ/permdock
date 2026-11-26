import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { z } from "zod";

const sampleRoot = path.join(import.meta.dirname, "..");

const BundleRow = z.object({
  route: z.string(),
  firstLoadUncompressedJsBytes: z.number(),
  firstLoadChunkPaths: z.array(z.string()),
});

function partOf(file: string): "framework" | "permdock" | "interface" | "app" {
  if (
    file.includes("framework") ||
    file.includes("polyfill") ||
    file.includes("main-app")
  ) {
    return "framework";
  }
  if (file.includes("permdock")) {
    return "permdock";
  }
  if (file.includes("reui") || file.includes("/ui/")) {
    return "interface";
  }
  return "app";
}

function gzipParts(chunks: readonly string[]): {
  readonly gzip: number;
  readonly parts: Readonly<Record<string, number>>;
} {
  const parts: Record<string, number> = {
    framework: 0,
    permdock: 0,
    interface: 0,
    app: 0,
  };
  let gzip = 0;
  const seen = new Set<string>();
  for (const chunk of chunks) {
    if (seen.has(chunk) || !existsSync(path.join(sampleRoot, chunk))) {
      continue;
    }
    seen.add(chunk);
    const size = gzipSync(readFileSync(path.join(sampleRoot, chunk))).length;
    gzip += size;
    const part = partOf(chunk);
    parts[part] = (parts[part] ?? 0) + size;
  }
  return { gzip, parts };
}

function findNamed(dir: string, name: string): string | null {
  if (!existsSync(dir)) {
    return null;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "cache") {
      const found = findNamed(full, name);
      if (found !== null) {
        return found;
      }
    }
    if (entry.name === name) {
      return full;
    }
  }
  return null;
}

/** Gzip of the proxy bundle Next emits, when this build has one. */
export function proxyGzip(): number | null {
  const file =
    findNamed(path.join(sampleRoot, ".next/server"), "proxy.js") ??
    findNamed(path.join(sampleRoot, ".next/server"), "middleware.js");
  if (file === null) {
    return null;
  }
  return gzipSync(readFileSync(file)).length;
}

/** Gzip of the first-load chunks Next records for each route. */
export function bundleSizes(): {
  readonly rows: readonly {
    readonly route: string;
    readonly uncompressed: number;
    readonly gzip: number;
    readonly parts: Readonly<Record<string, number>>;
  }[];
  readonly note: string | null;
} {
  const file = path.join(
    sampleRoot,
    ".next/diagnostics/route-bundle-stats.json",
  );
  if (!existsSync(file)) {
    return {
      rows: [],
      note: "route-bundle-stats.json was not written; first-load JS was not measured",
    };
  }
  const parsed = z
    .array(BundleRow)
    .parse(JSON.parse(readFileSync(file, "utf8")));
  return {
    rows: parsed.map((row) => {
      const sized = gzipParts(row.firstLoadChunkPaths);
      return {
        route: row.route,
        uncompressed: row.firstLoadUncompressedJsBytes,
        gzip: sized.gzip,
        parts: sized.parts,
      };
    }),
    note: "the four-way split matches chunk file names, which do not name source packages",
  };
}
