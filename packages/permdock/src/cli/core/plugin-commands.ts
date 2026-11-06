import type { PluginCommandResult } from "../generate/plugin.ts";

import { isPermDockPlugin } from "../generate/plugin.ts";
import { readConfig } from "../project/config.ts";

/**
 * The plugin command `permdock <name>` names, run; `undefined` when no
 * configured plugin declares one, so the caller reports an unknown command. A
 * config that cannot be read counts as no plugins here: the usual error follows
 * from the unknown command.
 */
export async function runPluginCommand(input: {
  readonly name: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly config?: string;
  readonly plugins?: readonly unknown[];
}): Promise<PluginCommandResult | undefined> {
  let items = input.plugins;
  let config = {};
  try {
    const loaded = await readConfig(input.cwd, input.config);
    config = loaded.config;
    items ??= loaded.config.plugins;
  } catch {
    return undefined;
  }
  for (const item of items ?? []) {
    if (!isPermDockPlugin(item)) {
      continue;
    }
    const command = item.commands?.find(
      (candidate) => candidate.name === input.name,
    );
    if (command?.run !== undefined) {
      return command.run({ cwd: input.cwd, config, args: input.args });
    }
  }
  return undefined;
}
