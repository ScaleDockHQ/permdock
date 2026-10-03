import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { CatalogDocument, CliIo, PermDockConfig } from "./types.ts";

import {
  buildCatalog,
  catalogSchemaDocument,
  formatCatalogJson,
  formatCatalogMarkdown,
} from "./catalog-doc.ts";
import { runCollect } from "./collect.ts";
import { defaultSrcPath, listSourceFiles } from "./files.ts";
import {
  asPermissionTree,
  leavesOf,
  loadModule,
  pickNamed,
  loadConfiguredPolicy,
} from "./load.ts";
import { scanSources } from "./scan.ts";

export async function runCatalog(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly format: "json" | "schema" | "markdown";
  readonly from: string | undefined;
  readonly include: readonly string[];
  readonly now: Date;
  readonly io: CliIo;
}): Promise<{ readonly code: 0 | 1 | 2; readonly output: string }> {
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
