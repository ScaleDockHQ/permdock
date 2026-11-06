import type { Policy } from "../../core/policy-types.ts";
import type { ProjectContext } from "./context.ts";
import type { PolicyModel } from "./model.ts";
import type { PermDockPlugin, PluginTask } from "./plugin.ts";

import { applyFiles, planFiles } from "../core/files.ts";
import { policyModel } from "./model.ts";
import { orderPlugins } from "./plugin.ts";

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
  const summary = { created: 0, updated: 0, unchanged: 0, planned: 0 };
  for (const file of files) {
    summary[file.outcome] += 1;
  }
  return summary;
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
  readonly ctx: ProjectContext;
  readonly check: boolean;
  readonly dryRun: boolean;
}): Promise<GenerateRun> {
  const model = policyModel(input.policy);
  const plugins = orderPlugins(input.plugins);
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
  const emitted: { plugin: string; path: string; contents: string }[] = [];
  for (const item of tasks) {
    for (const file of await item.plugin.emit(item.task, model)) {
      emitted.push({
        plugin: item.plugin.name,
        path: file.path,
        contents: file.contents,
      });
    }
  }
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
