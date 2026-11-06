import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExitCode } from "../core/errors.ts";
import type { CommandResult } from "../core/result.ts";
import type { PermDockConfig } from "../types.ts";
import type { GenerateRun, GenerateSummary } from "./pipeline.ts";
import type { PermDockPlugin } from "./plugin.ts";

import { suggestion } from "../core/args.ts";
import { CliError } from "../core/errors.ts";
import { runGen } from "../gen/gen.ts";
import { requirePolicy } from "../project/load.ts";
import { projectContext } from "./context.ts";
import { withImportGraph } from "./import-graph.ts";
import { runGenerate } from "./pipeline.ts";
import { isPermDockPlugin } from "./plugin.ts";

export type GenerateRequest = {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly policyPath: string | undefined;
  readonly only: readonly string[];
  readonly check: boolean;
  readonly dryRun: boolean;
  readonly noCache: boolean;
  readonly cacheDir?: string;
  readonly concurrency?: number;
};

export type GenerateExecution = {
  readonly run: GenerateRun;
  readonly code: ExitCode;
  readonly output: string;
  readonly summary: GenerateSummary;
  /** Absolute paths this cycle wrote, so the watcher can ignore them. */
  readonly written: readonly string[];
  /** Absolute policy, config-import and plugin input files to watch. */
  readonly inputs: readonly string[];
};

function pluginsOf(value: readonly unknown[] | undefined): PermDockPlugin[] {
  if (value === undefined) {
    return [];
  }
  const plugins: PermDockPlugin[] = [];
  for (const item of value) {
    if (!isPermDockPlugin(item)) {
      throw new CliError(
        "usage",
        "plugins must be an array of definePlugin() results",
        { code: "config_invalid" },
      );
    }
    plugins.push(item);
  }
  return plugins;
}

function selected(
  plugins: readonly PermDockPlugin[],
  only: readonly string[],
): PermDockPlugin[] {
  if (only.length === 0) {
    return [...plugins];
  }
  const names = plugins.map((plugin) => plugin.name);
  for (const name of only) {
    if (!names.includes(name)) {
      throw new CliError(
        "usage",
        `unknown plugin '${name}'.${suggestion(name, names)}`,
        { code: "invalid_value" },
      );
    }
  }
  return plugins.filter((plugin) => only.includes(plugin.name));
}

/**
 * A loaded `file:` URL inside the project, or `undefined` for a dependency or a
 * parent.
 */
export function localInput(cwd: string, url: string): string | undefined {
  if (!url.startsWith("file:")) {
    return undefined;
  }
  const path = fileURLToPath(url);
  const rel = relative(cwd, path);
  if (rel.startsWith("..") || rel.split("/").includes("node_modules")) {
    return undefined;
  }
  return path;
}

/**
 * One generate, including typed modules when `config.gen` is set. Validates the
 * policy and plugins before `runGenerate` writes.
 */
export async function executeGenerate(
  input: GenerateRequest,
): Promise<GenerateExecution> {
  const plugins = selected(pluginsOf(input.config.plugins), input.only);
  const loaded = await withImportGraph(() =>
    requirePolicy(
      input.cwd,
      input.policyPath,
      "generate needs policy in permdock.config.ts or --policy",
    ),
  );
  const project = await projectContext(input.cwd);
  const inputs = new Set<string>();
  for (const url of loaded.files) {
    const path = localInput(input.cwd, url);
    if (path !== undefined) {
      inputs.add(path);
    }
  }
  if (input.policyPath !== undefined && input.policyPath !== "") {
    inputs.add(resolve(input.cwd, input.policyPath));
  }
  for (const plugin of plugins) {
    const found = await plugin.inputs(project);
    for (const file of found.files) {
      inputs.add(resolve(input.cwd, file));
    }
  }
  const run = await runGenerate({
    cwd: input.cwd,
    policy: loaded.value,
    plugins,
    config: input.config,
    ctx: project,
    check: input.check,
    dryRun: input.dryRun,
    noCache: input.noCache,
    ...(input.cacheDir === undefined ? {} : { cacheDir: input.cacheDir }),
    ...(input.concurrency === undefined
      ? {}
      : { concurrency: input.concurrency }),
    importGraph: loaded.files,
  });
  const written = run.files.map((file) => resolve(input.cwd, file.path));
  if (input.config.gen === undefined) {
    return {
      run,
      code: run.code,
      output: input.check ? run.diff : "",
      summary: run.summary,
      written,
      inputs: [...inputs],
    };
  }
  const typed = await typedModules(input);
  return {
    run,
    code: run.code === 0 ? typed.code : run.code,
    output: [input.check ? run.diff : "", typed.output]
      .filter((part) => part !== "")
      .join("\n"),
    summary: run.summary,
    written: [...written, ...typed.written],
    inputs: [...inputs],
  };
}

async function typedModules(
  input: GenerateRequest,
): Promise<CommandResult & { readonly written: readonly string[] }> {
  const typed = await runGen({
    cwd: input.cwd,
    config: input.config,
    kinds: [],
    check: input.check,
    dryRun: input.dryRun,
    ...(input.policyPath === undefined || input.policyPath === ""
      ? {}
      : { from: input.policyPath }),
  });
  const files: unknown = Reflect.get(typed.data ?? {}, "files");
  const written: string[] = [];
  if (Array.isArray(files)) {
    for (const file of files) {
      if (file !== null && typeof file === "object" && "path" in file) {
        const path: unknown = Reflect.get(file, "path");
        if (typeof path === "string") {
          written.push(resolve(input.cwd, path));
        }
      }
    }
  }
  return { ...typed, written };
}
