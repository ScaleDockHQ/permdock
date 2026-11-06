import type { Leaf } from "../core/command.ts";
import type { PermDockPlugin } from "../generate/plugin.ts";

import { suggestion } from "../core/args.ts";
import { defineLeaf } from "../core/command.ts";
import { CliError } from "../core/errors.ts";
import { checkFlag, dryRunFlag, policyFlag } from "../core/flags.ts";
import { projectContext } from "../generate/context.ts";
import { runGenerate } from "../generate/pipeline.ts";
import { isPermDockPlugin } from "../generate/plugin.ts";
import { requirePolicy } from "../project/load.ts";

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

export const generate: Leaf = defineLeaf({
  flags: {
    ...checkFlag,
    ...dryRunFlag,
    ...policyFlag,
    only: {
      type: "string",
      description: "Run this plugin; repeat for more than one",
      valueHint: "plugin",
      repeatable: true,
    },
  },
  async run(ctx, { flags }) {
    const phase = ctx.progress("Generating");
    try {
      const path =
        flags.policy !== undefined && flags.policy !== ""
          ? flags.policy
          : ctx.config.policy;
      const policy = await requirePolicy(
        ctx.cwd,
        path,
        "generate needs policy in permdock.config.ts or --policy",
      );
      const project = await projectContext(ctx.cwd);
      const result = await runGenerate({
        cwd: ctx.cwd,
        policy,
        plugins: selected(pluginsOf(ctx.config.plugins), flags.only),
        config: ctx.config,
        ctx: project,
        check: flags.check,
        dryRun: flags["dry-run"],
      });
      const wrote = result.summary.created + result.summary.updated;
      phase.done(`Generated ${wrote} ${wrote === 1 ? "file" : "files"}`);
      if (result.summary.unchanged > 0) {
        ctx.io.stderr(`Unchanged ${result.summary.unchanged}\n`);
      }
      return {
        code: result.code,
        output: flags.check ? result.diff : "",
        data: { files: result.files, summary: result.summary },
      };
    } catch (error) {
      phase.done();
      throw error;
    }
  },
});
