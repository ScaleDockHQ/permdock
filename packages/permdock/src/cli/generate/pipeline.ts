import { statSync } from "node:fs";
import { resolve } from "node:path";

import type { Policy } from "../../core/policy-types.ts";
import type { PermDockConfig } from "../types.ts";
import type { ProjectContext } from "./context.ts";
import type { PolicyModel } from "./model.ts";
import type {
  EmittedFile,
  PermDockPlugin,
  PluginEmit,
  PluginInputs,
  PluginTask,
} from "./plugin.ts";

import { canonicalJson } from "../../core/canonical-json.ts";
import { applyFiles, planFiles } from "../core/files.ts";
import {
  cacheDirectory,
  cacheHit,
  hashText,
  inputsKey,
  optionsKey,
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
  /** Bytes the file holds after this run. */
  readonly bytes: number;
  /** `bytes` minus the bytes on disk before; `bytes` for a new file. */
  readonly delta: number;
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
  /** Lines from plugins, printed after the Generated line. */
  readonly notes: readonly string[];
  readonly code: 0 | 1;
};

function partsOf(produced: PluginEmit): {
  readonly files: readonly EmittedFile[];
  readonly notes: readonly string[];
} {
  return { files: produced, notes: produced.notes ?? [] };
}

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

function bytesOnDisk(abs: string): number {
  try {
    return statSync(abs).isFile() ? statSync(abs).size : 0;
  } catch {
    return 0;
  }
}

function sizeOf(file: GeneratedFile): string {
  const sign = file.delta >= 0 ? "+" : "-";
  return `${sign}${String(Math.abs(file.delta))} bytes, ${String(file.bytes)} total`;
}

function diffOf(files: readonly GeneratedFile[]): string {
  const rows: string[] = [];
  for (const file of files) {
    switch (file.outcome) {
      case "created":
        rows.push(`+ ${file.path} (${sizeOf(file)})`);
        break;
      case "updated":
        rows.push(`~ ${file.path} (${sizeOf(file)})`);
        break;
      case "planned":
        rows.push(
          `${file.delta === file.bytes ? "+" : "~"} ${file.path} (${sizeOf(file)})`,
        );
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
  /** `--db-url-stdin`, passed to plugins that read the database. */
  readonly db?: string;
  /** Module URLs recorded while the policy loaded. Part of the cache key. */
  readonly importGraph?: readonly string[];
}): Promise<GenerateRun> {
  const model = policyModel(input.policy);
  const plugins = orderPlugins(input.plugins);
  const useCache = input.noCache !== true && !input.check && !input.dryRun;
  const declared: PluginInputs[] = [];
  for (const plugin of plugins) {
    declared.push(await plugin.inputs(input.ctx));
  }
  const configWithoutPlugins = Object.fromEntries(
    Object.entries(input.config).filter(([name]) => name !== "plugins"),
  );
  const key = hashText(
    [
      ...plugins.map((plugin, index) => {
        const inputs = declared[index];
        return [
          `${plugin.name}@${plugin.version}`,
          optionsKey(inputs?.options),
          ...inputsKey(input.cwd, inputs?.files ?? []),
        ].join("|");
      }),
      optionsKey(configWithoutPlugins),
      ...inputsKey(input.cwd, ["supabase/config.toml"]),
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
        bytes: bytesOnDisk(resolve(input.cwd, file.path)),
        delta: 0,
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
        notes: [],
        code: 0,
      };
    }
  }
  const tasks: {
    readonly plugin: PermDockPlugin;
    readonly task: PluginTask;
  }[] = [];
  for (const plugin of plugins) {
    for (const task of await plugin.plan(model, input.ctx)) {
      tasks.push({ plugin, task });
    }
  }
  const groups = await mapLimited(
    tasks,
    concurrencyOf(input.concurrency),
    async (item) => {
      const produced = partsOf(
        await item.plugin.emit(item.task, model, {
          cwd: input.cwd,
          config: input.config,
          policy: input.policy,
          ...(input.db === undefined ? {} : { db: input.db }),
        }),
      );
      return {
        files: produced.files.map((file) => ({
          plugin: item.plugin.name,
          path: file.path,
          contents: file.contents,
        })),
        notes: produced.notes,
      };
    },
  );
  const notes = groups.flatMap((group) => group.notes);
  const emitted = groups.flatMap((group) => group.files);
  for (const plugin of plugins) {
    for (const file of (await plugin.seeds?.(model, input.ctx)) ?? []) {
      emitted.push({ plugin: plugin.name, ...file });
    }
    for (const finding of (await plugin.doctor?.(model, input.ctx)) ?? []) {
      notes.push(`${finding.code} ${finding.severity}: ${finding.message}`);
    }
  }
  const bodies = emitted.map((item) => ({
    path: item.path,
    text: item.contents,
  }));
  const planned = planFiles(input.cwd, bodies);
  const before = new Map<string, number>(
    bodies.map((body) => [
      body.path,
      bytesOnDisk(resolve(input.cwd, body.path)),
    ]),
  );
  const write = input.check !== true && input.dryRun !== true;
  const applied = write ? applyFiles(input.cwd, bodies) : planned;
  const files: GeneratedFile[] = applied.map((file, index) => {
    const bytes = Buffer.byteLength(emitted[index]?.contents ?? "");
    return {
      path: file.path,
      plugin: emitted[index]?.plugin ?? "",
      outcome:
        input.dryRun === true && file.outcome !== "unchanged"
          ? "planned"
          : file.outcome,
      bytes,
      delta: bytes - (before.get(file.path) ?? 0),
    };
  });
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
    notes,
    code: input.check === true && drifted ? 1 : 0,
  };
}
