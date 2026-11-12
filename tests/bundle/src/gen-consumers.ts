import type { Plugin } from "esbuild";

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BIN = join(
  ROOT,
  "..",
  "..",
  "packages",
  "permdock",
  "dist",
  "cli",
  "bin.js",
);
const FIXTURE = join(HERE, "fixtures", "gen-shake");

const CONFIG = (zod: string, out: string): string => `export default {
  policy: "./policy.ts",
  gen: { out: "${out}", kinds: ["constants", "sql", "zod", "valibot", "standard-schema"]${zod} },
  rls: {
    tables: { alpha: "public.alphas", beta: "public.betas" },
    realtime: {
      topics: {
        "org:{organization}:alpha": { read: "alpha.read" },
        "org:{organization}:beta": { read: "beta.read" },
      },
    },
  },
};
`;

/** The generated modules of the two-resource fixture, written by the built CLI. */
export type GeneratedProject = { readonly dir: string; readonly mini: string };

/**
 * Runs `permdock gen` twice (classic Zod and `zod/mini`) in a temporary
 * project.
 */
export function generateProject(): GeneratedProject {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const dir = mkdtempSync(join(ROOT, "tmp", "gen-shake-"));
  cpSync(join(FIXTURE, "policy.ts"), join(dir, "policy.ts"));
  const run = (config: string): void => {
    writeFileSync(join(dir, "permdock.config.ts"), config);
    const result = spawnSync(
      process.execPath,
      [BIN, "generate", "--no-cache"],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PERMDOCK_AGENT: "no" },
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `permdock gen exited ${String(result.status)}\n${result.stderr}`,
      );
    }
  };
  run(CONFIG("", "out"));
  run(CONFIG(', zod: { specifier: "zod/mini" }', "out-mini"));
  return { dir, mini: "out-mini" };
}

export function removeProject(project: GeneratedProject): void {
  rmSync(project.dir, { recursive: true, force: true });
}

function serverOnlyStub(): Plugin {
  return {
    name: "server-only",
    setup(pluginBuild): void {
      // oxlint-disable-next-line eslint/require-unicode-regexp -- esbuild runs the filter as a Go regexp, which has no u flag
      pluginBuild.onResolve({ filter: /^server-only$/ }, () => ({
        path: "server-only",
        namespace: "stub",
      }));
      // oxlint-disable-next-line eslint/require-unicode-regexp -- esbuild runs the filter as a Go regexp, which has no u flag
      pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: "",
        loader: "js",
      }));
    },
  };
}

/** The minified, tree-shaken text a page that imports `source` ships. */
export async function pageBundle(
  project: GeneratedProject,
  source: string,
): Promise<{ readonly text: string; readonly gzip: number }> {
  const result = await build({
    stdin: { contents: source, resolveDir: project.dir, loader: "ts" },
    bundle: true,
    write: false,
    minify: true,
    treeShaking: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["import", "default"],
    logLevel: "silent",
    plugins: [serverOnlyStub()],
  });
  const contents = result.outputFiles.map((file) => file.contents);
  return {
    text: result.outputFiles.map((file) => file.text).join(""),
    gzip: contents.reduce(
      (total, item) => total + gzipSync(item, { level: 9 }).length,
      0,
    ),
  };
}

/** One page per generated unit; each imports the `alpha` unit and not `beta`. */
export const PAGES = {
  "gen zod alphaRow": (dir: string): string =>
    `export { alphaRow } from "./${dir}/zod.ts";`,
  "gen zod/mini alphaRow": (_dir: string, mini: string): string =>
    `export { alphaRow } from "./${mini}/zod.ts";`,
  "gen valibot alphaRow": (dir: string): string =>
    `export { alphaRow } from "./${dir}/valibot.ts";`,
  "gen standard-schema alphaRow": (dir: string): string =>
    `export { alphaRow } from "./${dir}/standard-schema.ts";`,
  "gen constants orgAlphaTopic": (dir: string): string =>
    `export { orgAlphaTopic } from "./${dir}/constants.ts";`,
  "gen sql permittedOrganizationIds": (dir: string): string =>
    `export { permittedOrganizationIds } from "./${dir}/sql.ts";`,
} as const;

export async function measureGenConsumers(): Promise<Record<string, number>> {
  const project = generateProject();
  try {
    const sizes: Record<string, number> = {};
    for (const [name, source] of Object.entries(PAGES)) {
      sizes[name] = (
        await pageBundle(project, source("out", project.mini))
      ).gzip;
    }
    return sizes;
  } finally {
    removeProject(project);
  }
}

export function readRecorded(path: string): Record<string, number> {
  // SAFETY: write-baseline.ts writes this file in this shape.
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
}
