import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import type { CommandResult } from "../core/result.ts";

import { CliError } from "../core/errors.ts";
import { type PlannedFile, applyFiles, refuseDirty } from "../core/files.ts";
import { rel } from "../files.ts";
import { rewriteCliCalls } from "./cli-calls.ts";
import { RENAMES_0_5, SIGNATURE_CHANGES_0_5 } from "./renames-0.5.ts";
import {
  AWAIT_RENAMES_0_5,
  CALL_RENAMES_0_5,
  DURATION_KEYS_0_5,
  FUNCTION_METHODS_0_5,
  METHOD_FUNCTIONS_0_5,
  OPTION_WRAPS_0_5,
  PROP_RENAMES_0_5,
  TEMPLATE_HINTS_0_5,
} from "./shapes-0.5.ts";
import {
  type CodemodChange,
  type CodemodFollowUp,
  type RenameSet,
  transformSource,
} from "./transform.ts";

export const CODEMOD_0_5: RenameSet = Object.freeze({
  renames: Object.freeze([...RENAMES_0_5, ...CALL_RENAMES_0_5]),
  signatures: SIGNATURE_CHANGES_0_5,
  props: PROP_RENAMES_0_5,
  templates: TEMPLATE_HINTS_0_5,
  awaits: AWAIT_RENAMES_0_5,
  methodFunctions: METHOD_FUNCTIONS_0_5,
  functionMethods: FUNCTION_METHODS_0_5,
  wraps: OPTION_WRAPS_0_5,
  durations: DURATION_KEYS_0_5,
});

/** Each codemod version and the rename map it applies. */
const CODEMODS: Readonly<Record<string, RenameSet>> = Object.freeze({
  "0.5": CODEMOD_0_5,
});

export function codemodVersions(): readonly string[] {
  return Object.keys(CODEMODS);
}

const EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
]);

/**
 * Files whose shell commands the codemod rewrites when the version renames CLI
 * names.
 */
const CLI_FILE_NAMES: ReadonlySet<string> = new Set([
  "package.json",
  "Makefile",
  "justfile",
  "Dockerfile",
]);
const CLI_EXTENSIONS: ReadonlySet<string> = new Set([".yml", ".yaml", ".sh"]);
/** Prose: the codemod lists the old calls in it and rewrites none. */
const CLI_REVIEW_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".mdx"]);

/** The versions whose renames include the CLI's own commands and flags. */
const CLI_RENAME_VERSIONS: ReadonlySet<string> = new Set(["0.5"]);

const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  ".git",
  ".next",
  ".turbo",
  ".svelte-kit",
  "coverage",
]);

export type CodemodFileReport = {
  readonly file: string;
  readonly changes: readonly CodemodChange[];
};

export type CodemodFollowUpReport = CodemodFollowUp & { readonly file: string };

/** What `permdock codemod <version> --json` prints. */
export type CodemodReport = {
  readonly version: string;
  readonly dryRun: boolean;
  readonly scanned: number;
  readonly files: readonly CodemodFileReport[];
  readonly followUps: readonly CodemodFollowUpReport[];
};

export type CodemodOptions = {
  readonly cwd: string;
  readonly version: string | undefined;
  readonly paths: readonly string[];
  readonly dryRun: boolean;
  /** Rewrite files with uncommitted changes too. */
  readonly force?: boolean;
  readonly json: boolean;
};

export function runCodemod(options: CodemodOptions): CommandResult {
  const report = codemod(options);
  return {
    code: 0,
    output: options.json
      ? JSON.stringify(report, null, 2)
      : formatReport(report),
  };
}

export function codemod(options: CodemodOptions): CodemodReport {
  const version = normaliseVersion(options.version);
  const set = CODEMODS[version];
  if (set === undefined) {
    throw new CliError(
      "usage",
      `unknown codemod version '${version}'. Supported: ${Object.keys(CODEMODS).join(", ")}.`,
    );
  }
  const files = sourceFiles(
    options.cwd,
    options.paths.length === 0 ? ["."] : options.paths,
    CLI_RENAME_VERSIONS.has(version),
  );
  const changed: CodemodFileReport[] = [];
  const followUps: CodemodFollowUpReport[] = [];
  const writes: PlannedFile[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("permdock")) {
      continue;
    }
    const name = rel(options.cwd, file);
    const result = isCodeFile(file)
      ? transformSource(file, source, set)
      : cliResult(file, source);
    if (result.error !== undefined) {
      followUps.push({
        file: name,
        line: 1,
        column: 1,
        name: "parse",
        message: `not parsed, left as it is: ${result.error}`,
      });
      continue;
    }
    if (result.changes.length > 0) {
      changed.push({ file: name, changes: result.changes });
      if (result.source !== source) {
        writes.push({ path: file, text: result.source });
      }
    }
    for (const followUp of result.followUps) {
      followUps.push({ file: name, ...followUp });
    }
  }
  if (!options.dryRun && writes.length > 0) {
    refuseDirty({
      command: "codemod",
      invocation: ["codemod", version, ...options.paths].join(" "),
      cwd: options.cwd,
      paths: writes.map((write) => write.path),
      force: options.force === true,
    });
    applyFiles(options.cwd, writes);
  }
  return {
    version,
    dryRun: options.dryRun,
    scanned: files.length,
    files: changed,
    followUps,
  };
}

function normaliseVersion(version: string | undefined): string {
  if (version === undefined) {
    throw new CliError(
      "usage",
      `codemod needs a version: permdock codemod <version>. Supported: ${Object.keys(CODEMODS).join(", ")}.`,
    );
  }
  const match = /^v?(\d+\.\d+)(?:\.\d+)?$/u.exec(version);
  return match?.[1] ?? version;
}

function isCodeFile(file: string): boolean {
  return EXTENSIONS.has(extname(file));
}

function isCliFile(name: string): boolean {
  return (
    CLI_FILE_NAMES.has(name) ||
    CLI_EXTENSIONS.has(extname(name)) ||
    CLI_REVIEW_EXTENSIONS.has(extname(name))
  );
}

function cliResult(
  file: string,
  source: string,
): ReturnType<typeof transformSource> {
  const result = rewriteCliCalls(source, { json: extname(file) === ".json" });
  if (!CLI_REVIEW_EXTENSIONS.has(extname(file))) {
    return {
      source: result.text,
      changes: result.changes,
      followUps: result.followUps,
    };
  }
  return {
    source,
    changes: [],
    followUps: [
      ...result.changes.map((change) => ({
        line: change.line,
        column: change.column,
        name: "cli",
        message: `${change.from} → ${change.to} since 0.5.0`,
      })),
      ...result.followUps,
    ],
  };
}

function sourceFiles(
  cwd: string,
  paths: readonly string[],
  cli: boolean,
): readonly string[] {
  const out = new Set<string>();
  for (const path of paths) {
    const root = resolve(cwd, path);
    const stats = statSync(root, { throwIfNoEntry: false });
    if (stats === undefined) {
      throw new CliError("usage", `not found: ${path}`);
    }
    if (stats.isFile()) {
      out.add(root);
    } else {
      walkDir(root, out, cli);
    }
  }
  return [...out].toSorted();
}

function walkDir(dir: string, out: Set<string>, cli: boolean): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) {
      continue;
    }
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walkDir(full, out, cli);
    } else if (EXTENSIONS.has(extname(name)) || (cli && isCliFile(name))) {
      out.add(full);
    }
  }
}

function formatReport(report: CodemodReport): string {
  const lines: string[] = [];
  const changes = report.files.reduce(
    (sum, file) => sum + file.changes.length,
    0,
  );
  const verb = report.dryRun ? "would change" : "changed";
  lines.push(
    `permdock codemod ${report.version}: ${verb} ${changes} ${changes === 1 ? "name" : "names"} in ${report.files.length} of ${report.scanned} ${report.scanned === 1 ? "file" : "files"}; ${report.followUps.length} manual ${report.followUps.length === 1 ? "follow-up" : "follow-ups"}${report.dryRun ? " (dry run, nothing written)" : ""}`,
  );
  for (const file of report.files) {
    lines.push("", file.file);
    for (const change of file.changes) {
      lines.push(
        `  ${change.line}:${change.column}  ${change.from} → ${change.to}`,
      );
    }
  }
  if (report.followUps.length > 0) {
    lines.push("", "Manual follow-ups");
    for (const item of report.followUps) {
      lines.push(`  ${item.file}:${item.line}:${item.column}  ${item.message}`);
    }
  }
  return lines.join("\n");
}
