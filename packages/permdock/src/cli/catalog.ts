import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CommandResult } from "./core/result.ts";
import type { CatalogDocument, CliIo, PermDockConfig } from "./types.ts";

import { isRecord } from "../core/compact.ts";
import {
  buildCatalog,
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
  if (from !== undefined) {
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
  } else {
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

/** The comparable form of a catalog file: without the fields every run changes. */
function comparable(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      const {
        generatedAt: _generatedAt,
        generator: _generator,
        ...rest
      } = parsed;
      return JSON.stringify(rest);
    }
  } catch {
    // Markdown and other text compare as written.
  }
  return text;
}

/** `catalog --out`: writes the export, or with `--check` exits 1 when the file differs. */
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
    const stale = comparable(readFileSync(path, "utf8")) !== comparable(text);
    return {
      code: stale ? 1 : 0,
      output: stale ? `catalog stale: ${out}` : `${out} is up to date`,
      data: { out, stale },
    };
  }
  const applied = applyFiles(cwd, [{ path: out, text }]);
  return {
    code: 0,
    output: fileSummary(applied, false),
    data: { files: applied },
  };
}
