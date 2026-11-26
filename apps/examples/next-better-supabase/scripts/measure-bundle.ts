import { existsSync, readFileSync } from "node:fs";
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
