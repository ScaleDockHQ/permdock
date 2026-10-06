import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import type { Policy } from "../index.ts";
import type {
  CatalogDocument,
  CliIo,
  CollectConfig,
  PermDockConfig,
  ScanResult,
} from "./types.ts";

import {
  buildCatalog,
  catalogForCompare,
  formatCatalogJson,
} from "./catalog-doc.ts";
import { catalogPath } from "./catalog-path.ts";
import { describeError } from "./errors.ts";
import { defaultSrcPath, listSourceFiles, rel } from "./files.ts";
import {
  asPermissionTree,
  leavesOf,
  loadModule,
  pickNamed,
  loadConfiguredPolicy,
} from "./load.ts";
import { scanSources } from "./scan.ts";
import { shortDiff } from "./text-diff.ts";

export type CollectOutcome = {
  readonly code: 0 | 1 | 2;
  readonly document: CatalogDocument | undefined;
  readonly scan: ScanResult | undefined;
  readonly outPath: string;
  readonly message: string;
  /** Absolute paths this run wrote, so a watcher can ignore its own output. */
  readonly written?: readonly string[];
};

export async function runCollect(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly collect: CollectConfig;
  readonly check: boolean;
  readonly now: Date;
  readonly io?: CliIo;
  /** Files to scan for references instead of `srcPath`, for doctor's own scan path; `check` still compares the catalog built from `srcPath`. */
  readonly scanPath?: readonly string[];
  readonly fresh?: boolean;
  /** The policy for the catalog's grants; default the configured policy module. */
  readonly loadPolicy?: () => Promise<Policy | undefined>;
}): Promise<CollectOutcome> {
  const load = { fresh: input.fresh === true };
  const srcPath =
    input.collect.srcPath ?? input.config.collect?.srcPath ?? defaultSrcPath();
  const outPath = catalogPath(input.config, input.cwd, input.collect.out);
  const permissionsRel =
    input.config.permissions ?? guessPermissions(input.cwd, srcPath);
  if (permissionsRel === undefined) {
    return {
      code: 2,
      document: undefined,
      scan: undefined,
      outPath,
      message:
        "usage: set permissions in permdock.config.ts or pass a definePermissions module",
    };
  }
  const permissionsAbs = resolve(input.cwd, permissionsRel);
  if (!existsSync(permissionsAbs)) {
    return {
      code: 2,
      document: undefined,
      scan: undefined,
      outPath,
      message: `PermDock CLI: permissions module not found: ${rel(input.cwd, permissionsAbs)}`,
    };
  }
  let tree;
  try {
    const mod = await loadModule(permissionsAbs, load);
    tree = asPermissionTree(pickNamed(mod, ["permissions"]));
  } catch (error) {
    return {
      code: 2,
      document: undefined,
      scan: undefined,
      outPath,
      message: describeError(error),
    };
  }
  const files = listSourceFiles(input.cwd, input.scanPath ?? srcPath);
  const knownKeys = new Set(leavesOf(tree).map((leaf) => leaf.key));
  const scan = scanSources(input.cwd, files, knownKeys);
  const policy =
    input.loadPolicy === undefined
      ? await loadConfiguredPolicy(input.cwd, input.config.policy, load)
      : await input.loadPolicy();
  const generatedAt = input.now.toISOString();
  const document = buildCatalog(tree, scan, generatedAt, policy);
  const next = formatCatalogJson(document);
  if (input.check) {
    if (!existsSync(outPath)) {
      return {
        code: 1,
        document,
        scan,
        outPath,
        message: `catalog missing: ${rel(input.cwd, outPath)}`,
      };
    }
    const current = readFileSync(outPath, "utf8");
    // SAFETY: only serialised again by catalogForCompare; any other shape just compares unequal.
    const currentDoc = JSON.parse(current) as CatalogDocument;
    const onDisk = catalogForCompare(currentDoc);
    const generated = catalogForCompare(
      input.scanPath === undefined || samePaths(input.scanPath, srcPath)
        ? document
        : buildCatalog(
            tree,
            scanSources(
              input.cwd,
              listSourceFiles(input.cwd, srcPath),
              knownKeys,
            ),
            generatedAt,
            policy,
          ),
    );
    if (onDisk !== generated) {
      const file = rel(input.cwd, outPath);
      return {
        code: 1,
        document,
        scan,
        outPath,
        message: `catalog drift: ${file}\n${shortDiff(file, onDisk, generated)}`,
      };
    }
    return {
      code: 0,
      document,
      scan,
      outPath,
      message: `catalog up to date: ${rel(input.cwd, outPath)}`,
    };
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, next);
  const written = [outPath];
  const barrel = input.collect.barrel ?? input.config.collect?.barrel;
  if (barrel !== undefined && barrel !== false) {
    const barrelPath = resolve(input.cwd, barrelFile(barrel));
    writeBarrel(barrelPath, permissionsAbs);
    written.push(barrelPath);
  }
  return {
    code: 0,
    document,
    scan,
    outPath,
    message: `wrote ${rel(input.cwd, outPath)}`,
    written,
  };
}

function samePaths(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/** The permissions module `collect` reads when the config names none. */
export function guessPermissions(
  cwd: string,
  srcPath: readonly string[],
): string | undefined {
  const candidates = [
    "src/permissions.ts",
    "permissions.ts",
    ...srcPath.map((entry) => `${entry.replace(/\/$/, "")}/permissions.ts`),
  ];
  return candidates.find((file) => existsSync(resolve(cwd, file)));
}

export function barrelFile(barrel: true | string): string {
  return barrel === true ? "src/permissions.generated.ts" : barrel;
}

function writeBarrel(abs: string, permissionsAbs: string): void {
  const specifier = relative(dirname(abs), permissionsAbs)
    .replace(/\\/gu, "/")
    .replace(/\.tsx?$/u, ".js");
  const body = `// @generated by permdock — do not edit
import { mergePermissions } from 'permdock'
import { permissions as collected } from '${specifier.startsWith(".") ? specifier : `./${specifier}`}'

export const permissions = mergePermissions(collected)
`;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}
