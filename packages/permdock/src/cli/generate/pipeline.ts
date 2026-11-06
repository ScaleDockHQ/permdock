import type { Policy } from "../../core/policy-types.ts";
import type { PermDockConfig } from "../types.ts";
import type { ProjectContext } from "./context.ts";
import type { PolicyModel } from "./model.ts";
import type { PermDockPlugin, PluginTask } from "./plugin.ts";

import { canonicalJson } from "../../core/canonical-json.ts";
import { applyFiles, planFiles } from "../core/files.ts";
import {
  cacheDirectory,
  cacheHit,
  hashText,
  readCache,
  writeCache,
} from "./cache.ts";
import { policyModel } from "./model.ts";
import { orderPlugins } from "./plugin.ts";
import { concurrencyOf, mapLimited } from "./pool.ts";

export type GenerateOutcome = "created" | "updated" | "unchanged" | "planned";

export type GeneratedFile = {
  readonly path: string;
  readonly plugin: string;
  readonly outcome: GenerateOutcome;
};

export type GenerateSummary = {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly planned: number;
  /** Files whose emit and write were skipped because the cache matched. */
  readonly skipped: number;
};

export type GenerateRun = {
  readonly model: PolicyModel;
  readonly files: readonly GeneratedFile[];
  readonly summary: GenerateSummary;
  /** `+`, `-` and `~` rows for files that would change. */
  readonly diff: string;
  readonly code: 0 | 1;
};

function summaryOf(files: readonly GeneratedFile[]): GenerateSummary {
  const summary = {
    created: 0,
    updated: 0,
    unchanged: 0,
    planned: 0,
    skipped: 0,
  };
  for (const file of files) {
    summary[file.outcome] += 1;
  }
  return summary;
}

/** Stderr rows after the Generated line. A cache hit is not Unchanged. */
export function receiptRows(summary: GenerateSummary): readonly string[] {
  const rows: string[] = [];
  if (summary.unchanged > 0) {
    rows.push(`Unchanged ${String(summary.unchanged)}`);
  }
  if (summary.skipped > 0) {
    rows.push(`Skipped (cache) ${String(summary.skipped)}`);
  }
  return rows;
}

function diffOf(files: readonly GeneratedFile[]): string {
  const rows: string[] = [];
  for (const file of files) {
    switch (file.outcome) {
      case "created":
        rows.push(`+ ${file.path}`);
        break;
      case "updated":
        rows.push(`~ ${file.path}`);
        break;
      case "planned":
        rows.push(`+ ${file.path}`);
        break;
      case "unchanged":
        break;
      default: {
        const never: never = file.outcome;
        return never;
      }
    }
  }
  return rows.join("\n");
}

/**
 * Plans and emits every plugin before the first write. `--check` and
 * `--dry-run` write nothing. Output order follows plugin order.
 */
export async function runGenerate(input: {
  readonly cwd: string;
  readonly policy: Policy;
  readonly plugins: readonly PermDockPlugin[];
  readonly config: PermDockConfig;
  readonly ctx: ProjectContext;
  readonly check: boolean;
  readonly dryRun: boolean;
  readonly noCache?: boolean;
  readonly cacheDir?: string;
  readonly concurrency?: number;
  /** Module URLs recorded while the policy loaded. Part of the cache key. */
  readonly importGraph?: readonly string[];
}): Promise<GenerateRun> {
  const model = policyModel(input.policy);
  const plugins = orderPlugins(input.plugins);
  const useCache = input.noCache !== true && !input.check && !input.dryRun;
  const key = hashText(
    [
      ...plugins.map((plugin) => `${plugin.name}@${plugin.version}`),
      canonicalJson(model),
      ...(input.importGraph ?? []),
    ].join("\n"),
  );
  const directory = cacheDirectory(input.cwd, input.cacheDir);
  if (useCache) {
    const cached = readCache(directory, key);
    if (cached !== undefined && cacheHit(input.cwd, cached)) {
      const files = cached.files.map((file) => ({
        path: file.path,
        plugin: file.plugin,
        outcome: "unchanged" as const,
      }));
      return {
        model,
        files,
        summary: {
          created: 0,
          updated: 0,
          unchanged: 0,
          planned: 0,
          skipped: files.length,
        },
        diff: "",
        code: 0,
      };
    }
  }
  const tasks: {
    readonly plugin: PermDockPlugin;
    readonly task: PluginTask;
  }[] = [];
  for (const plugin of plugins) {
    await plugin.inputs(input.ctx);
    for (const task of await plugin.plan(model, input.ctx)) {
      tasks.push({ plugin, task });
    }
  }
  const groups = await mapLimited(
    tasks,
    concurrencyOf(input.concurrency),
    async (item) => {
      const produced = await item.plugin.emit(item.task, model, {
        cwd: input.cwd,
        config: input.config,
        policy: input.policy,
      });
      return produced.map((file) => ({
        plugin: item.plugin.name,
        path: file.path,
        contents: file.contents,
      }));
    },
  );
  const emitted = groups.flat();
  const bodies = emitted.map((item) => ({
    path: item.path,
    text: item.contents,
  }));
  const planned = planFiles(input.cwd, bodies);
  const write = input.check !== true && input.dryRun !== true;
  const applied = write ? applyFiles(input.cwd, bodies) : planned;
  const files: GeneratedFile[] = applied.map((file, index) => ({
    path: file.path,
    plugin: emitted[index]?.plugin ?? "",
    outcome:
      input.dryRun === true && file.outcome !== "unchanged"
        ? "planned"
        : file.outcome,
  }));
  if (useCache && write) {
    writeCache(
      directory,
      key,
      emitted.map((file) => ({
        path: file.path,
        hash: hashText(file.contents),
        plugin: file.plugin,
      })),
    );
  }
  const summary = summaryOf(files);
  const drifted = summary.created + summary.updated + summary.planned > 0;
  return {
    model,
    files,
    summary,
    diff: diffOf(files),
    code: input.check === true && drifted ? 1 : 0,
  };
}
