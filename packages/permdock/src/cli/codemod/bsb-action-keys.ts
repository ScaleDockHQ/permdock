import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PlannedFile } from "../core/files.ts";
import type { CommandResult } from "../core/result.ts";
import type { BsbAction } from "../project/bsb-actions.ts";
import type { ConfigKey } from "./bsb-action-keys-edit.ts";

import { guessPermissions } from "../collect.ts";
import { CliError } from "../core/errors.ts";
import { applyFiles, refuseDirty } from "../core/files.ts";
import { rel } from "../files.ts";
import { betterSupabaseConfigPath } from "../project/better-supabase.ts";
import { answerOf, bsbActions } from "../project/bsb-actions.ts";
import { readConfig } from "../project/config.ts";
import { addAnswers, removeConfigKeys } from "./bsb-action-keys-edit.ts";

/** What `permdock codemod bsb-action-keys --json` prints. */
export type ActionKeyReport = {
  /** Each key moved from the better-supabase config to a permission's `answers`. */
  readonly moved: readonly { readonly key: string; readonly answer: string }[];
  /** Config keys left in place, with the reason. */
  readonly kept: readonly {
    readonly key: string;
    readonly answer: string;
    readonly reason: string;
  }[];
  readonly files: readonly string[];
};

async function configuredActions(
  cwd: string,
  path: string,
): Promise<readonly BsbAction[]> {
  const listed = await bsbActions(cwd, path);
  switch (listed.kind) {
    case "actions": {
      return listed.actions.filter(
        (action) => action.kind === "block" && action.source === "config",
      );
    }
    case "missing": {
      throw new CliError(
        "usage",
        "codemod bsb-action-keys needs better-supabase installed in the project",
        { code: "dependency_missing" },
      );
    }
    case "old": {
      throw new CliError(
        "usage",
        "codemod bsb-action-keys needs better-supabase 0.84.0 or later, which exports listActions from better-supabase/sql",
        { code: "dependency_missing" },
      );
    }
    case "invalid": {
      throw new CliError(
        "usage",
        `codemod bsb-action-keys: better-supabase refused ${rel(cwd, path)}: ${listed.message}`,
        { code: "config_invalid" },
      );
    }
    default: {
      const never: never = listed;
      return never;
    }
  }
}

/**
 * `permdock codemod bsb-action-keys`: moves each string key a better-supabase
 * config's `blocks` entry names under `permissions` to the `answers` of the
 * permission with that key. Only the keys `listActions` reports with source
 * `config` move; a key stays, and is listed, when the config names it outside a
 * literal `blocks` entry or the permissions module declares the action in a
 * form the codemod does not edit.
 */
export async function runActionKeys(options: {
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly json: boolean;
}): Promise<CommandResult> {
  const { config } = await readConfig(options.cwd);
  const configured = config.betterSupabase?.config;
  const configPath = betterSupabaseConfigPath({
    cwd: options.cwd,
    ...(configured === undefined ? {} : { path: configured }),
  });
  if (configPath === undefined) {
    throw new CliError(
      "usage",
      "codemod bsb-action-keys found no better-supabase.config.ts; set betterSupabase.config in permdock.config",
      { code: "config_not_found" },
    );
  }
  const permissionsRel =
    config.permissions ??
    guessPermissions(options.cwd, config.collect?.srcPath ?? []);
  if (permissionsRel === undefined) {
    throw new CliError(
      "usage",
      "codemod bsb-action-keys needs `permissions` in permdock.config",
      { code: "config_not_found" },
    );
  }
  const permissionsPath = resolve(options.cwd, permissionsRel);
  const actions = await configuredActions(options.cwd, configPath);
  const listedKey = (entry: ConfigKey): boolean =>
    actions.some(
      (action) =>
        action.name === entry.instance &&
        action.action === entry.action &&
        action.key === entry.key,
    );
  const configSource = readFileSync(configPath, "utf8");
  const found = removeConfigKeys(configPath, configSource, listedKey).removed;
  const answers = new Map<string, string[]>();
  for (const entry of found) {
    const answer = answerOf({
      kind: "block",
      name: entry.instance,
      action: entry.action,
      key: entry.key,
      source: "config",
    });
    answers.set(entry.key, [...(answers.get(entry.key) ?? []), answer]);
  }
  const permissionsSource = readFileSync(permissionsPath, "utf8");
  const added = addAnswers(permissionsPath, permissionsSource, answers);
  const unanswered = new Set(added.missing);
  const removed = removeConfigKeys(
    configPath,
    configSource,
    (entry) => listedKey(entry) && !unanswered.has(entry.key),
  );
  const moved = removed.removed.map((entry) => ({
    key: entry.key,
    answer: `blocks.${entry.instance}.${entry.action}`,
  }));
  const kept = actions
    .filter(
      (action) =>
        !removed.removed.some(
          (entry) =>
            entry.instance === action.name && entry.action === action.action,
        ),
    )
    .map((action) => ({
      key: action.key ?? "",
      answer: answerOf(action),
      reason:
        action.key !== null && unanswered.has(action.key)
          ? `${rel(options.cwd, permissionsPath)} does not declare ${action.key} as an action of a resource() call in definePermissions`
          : `${rel(options.cwd, configPath)} does not name it as a string in a blocks entry's permissions`,
    }));
  const planned: PlannedFile[] = [];
  if (removed.source !== configSource) {
    planned.push({ path: configPath, text: removed.source });
  }
  if (moved.length > 0 && added.source !== permissionsSource) {
    planned.push({ path: permissionsPath, text: added.source });
  }
  if (!options.dryRun) {
    refuseDirty({
      command: "codemod",
      invocation: "codemod bsb-action-keys",
      cwd: options.cwd,
      paths: planned.map((file) => file.path),
      force: options.force,
    });
    applyFiles(options.cwd, planned);
  }
  const report: ActionKeyReport = {
    moved,
    kept,
    files: planned.map((file) => rel(options.cwd, file.path)),
  };
  if (options.json) {
    return { code: 0, output: JSON.stringify(report, null, 2), data: report };
  }
  return {
    code: 0,
    output: [
      `permdock codemod bsb-action-keys: ${options.dryRun ? "would move" : "moved"} ${String(moved.length)} ${moved.length === 1 ? "key" : "keys"} to answers`,
      ...moved.map((entry) => `  ${entry.key}: answers ${entry.answer}`),
      ...kept.map((entry) => `  kept ${entry.answer}: ${entry.reason}`),
    ].join("\n"),
  };
}
