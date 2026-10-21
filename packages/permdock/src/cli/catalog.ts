import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CommandResult } from "./core/result.ts";
import type { CatalogDocument, CliIo, PermDockConfig } from "./types.ts";

import { isRecord } from "../core/compact.ts";
import {
  buildCatalog,
  catalogForCompare,
  catalogForDrift,
  catalogSchemaDocument,
  formatCatalogJson,
  formatCatalogMarkdown,
} from "./catalog-doc.ts";
import { loadConfiguredOperations } from "./catalog-operations.ts";
import { runCollect } from "./collect.ts";
import { applyFiles, fileSummary } from "./core/files.ts";
import { defaultSrcPath, listSourceFiles } from "./files.ts";
import {
  asPermissionTree,
  leavesOf,
  loadModule,
  pickNamed,
  loadConfiguredPolicy,
} from "./project/load.ts";
import { scanSources } from "./scan.ts";

export async function runCatalog(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly format: "json" | "schema" | "markdown";
  readonly from: string | undefined;
  readonly include: readonly string[];
  readonly now: Date;
  readonly io: CliIo;
}): Promise<CommandResult> {
  if (input.format === "schema") {
    return {
      code: 0,
      output: `${JSON.stringify(catalogSchemaDocument(), null, 2)}\n`,
    };
  }
  const from = input.from ?? input.config.permissions;
  let document: CatalogDocument;
  if (from === undefined) {
    const collected = await runCollect({
      cwd: input.cwd,
      config: input.config,
      collect: input.config.collect ?? {},
      check: false,
      now: input.now,
      io: input.io,
    });
    if (collected.document === undefined) {
      return { code: collected.code, output: collected.message };
    }
    document = collected.document;
  } else {
    const abs = resolve(input.cwd, from);
    if (!existsSync(abs)) {
      return { code: 2, output: `PermDock CLI: module not found: ${from}` };
    }
    const tree = asPermissionTree(
      pickNamed(await loadModule(abs), ["permissions"]),
    );
    const srcPath = input.config.collect?.srcPath ?? defaultSrcPath();
    const files = listSourceFiles(input.cwd, srcPath);
    const scan = scanSources(
      input.cwd,
      files,
      new Set(leavesOf(tree).map((leaf) => leaf.key)),
    );
    document = buildCatalog(
      tree,
      scan,
      input.now.toISOString(),
      await loadConfiguredPolicy(input.cwd, input.config.policy),
      await loadConfiguredOperations(input.cwd, input.config.operations),
    );
  }
  const filtered =
    input.include.length === 0
      ? document
      : {
          ...document,
          permissions: document.permissions.filter((permission) =>
            input.include.some(
              (prefix) =>
                permission.key === prefix ||
                permission.key.startsWith(`${prefix}.`) ||
                permission.resource === prefix,
            ),
          ),
        };
  if (input.format === "markdown") {
    return { code: 0, output: formatCatalogMarkdown(filtered) };
  }
  return { code: 0, output: formatCatalogJson(filtered) };
}

/**
 * The comparable forms of a catalog file: without the fields every run changes,
 * then also without `usages[].line`.
 */
function comparable(text: string): {
  readonly full: string;
  readonly drift: string;
} {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      // SAFETY: only serialised again by catalogForCompare and catalogForDrift, which tolerate any shape.
      const doc = parsed as CatalogDocument;
      return { full: catalogForCompare(doc), drift: catalogForDrift(doc) };
    }
  } catch {
    // Markdown and other text compare as written.
  }
  return { full: text, drift: text };
}

/**
 * `catalog --out`: writes the export, or with `--check` exits 1 when the file
 * differs by more than usage line numbers.
 */
export function catalogFile(
  cwd: string,
  out: string,
  text: string,
  check: boolean,
): CommandResult {
  if (check) {
    const path = resolve(cwd, out);
    if (!existsSync(path)) {
      return {
        code: 1,
        output: `catalog missing: ${out}`,
        data: { out, stale: true },
      };
    }
    const onDisk = comparable(readFileSync(path, "utf8"));
    const generated = comparable(text);
    if (onDisk.full === generated.full) {
      return {
        code: 0,
        output: `${out} is up to date`,
        data: { out, stale: false },
      };
    }
    if (onDisk.drift === generated.drift) {
      return {
        code: 0,
        output: `catalog usages moved (lines only): ${out}; run permdock collect to refresh`,
        data: { out, stale: false, positionsMoved: true },
      };
    }
    return {
      code: 1,
      output: `catalog stale: ${out}`,
      data: { out, stale: true },
    };
  }
  const applied = applyFiles(cwd, [{ path: out, text }]);
  return {
    code: 0,
    output: fileSummary(applied, false),
    data: { files: applied },
  };
}
