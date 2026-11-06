import type { Leaf } from "../core/command.ts";
import type { PermDockPlugin } from "../generate/plugin.ts";

import { suggestion } from "../core/args.ts";
import { defineLeaf } from "../core/command.ts";
import { CliError } from "../core/errors.ts";
import { checkFlag, dryRunFlag, policyFlag } from "../core/flags.ts";
import { runGen } from "../gen/gen.ts";
import { projectContext } from "../generate/context.ts";
import { withImportGraph } from "../generate/import-graph.ts";
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

function concurrencyFlag(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliError("usage", "--concurrency must be a positive integer", {
      code: "invalid_value",
    });
  }
  return parsed;
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
    "no-cache": {
      type: "boolean",
      description: "Emit and write even when a cache entry matches",
    },
    "cache-dir": {
      type: "string",
      description:
        "Cache directory (default node_modules/.cache/permdock or PERMDOCK_CACHE_DIR)",
      valueHint: "dir",
    },
    concurrency: {
      type: "string",
      description:
        "How many tasks run at once. 1 runs them one at a time. Default is one less than the CPU count.",
      valueHint: "n",
    },
  },
  async run(ctx, { flags }) {
    const phase = ctx.progress("Generating");
    try {
      const path =
        flags.policy !== undefined && flags.policy !== ""
          ? flags.policy
          : ctx.config.policy;
      const concurrency = concurrencyFlag(flags.concurrency);
      const loaded = await withImportGraph(() =>
        requirePolicy(
          ctx.cwd,
          path,
          "generate needs policy in permdock.config.ts or --policy",
        ),
      );
      const project = await projectContext(ctx.cwd);
      const result = await runGenerate({
        cwd: ctx.cwd,
        policy: loaded.value,
        plugins: selected(pluginsOf(ctx.config.plugins), flags.only),
        config: ctx.config,
        ctx: project,
        check: flags.check,
        dryRun: flags["dry-run"],
        noCache: flags["no-cache"],
        ...(flags["cache-dir"] === undefined || flags["cache-dir"] === ""
          ? {}
          : { cacheDir: flags["cache-dir"] }),
        ...(concurrency === undefined ? {} : { concurrency }),
        importGraph: loaded.files,
      });
      const wrote = result.summary.created + result.summary.updated;
      phase.done(`Generated ${wrote} ${wrote === 1 ? "file" : "files"}`);
      if (result.summary.unchanged > 0) {
        ctx.io.stderr(`Unchanged ${result.summary.unchanged}\n`);
      }
      const generated = ctx.config.gen;
      if (generated === undefined) {
        return {
          code: result.code,
          output: flags.check ? result.diff : "",
          data: { files: result.files, summary: result.summary },
        };
      }
      const typed = await runGen({
        cwd: ctx.cwd,
        config: ctx.config,
        kinds: [],
        check: flags.check,
        dryRun: flags["dry-run"],
        ...(flags.policy === undefined || flags.policy === ""
          ? {}
          : { from: flags.policy }),
      });
      const output = [flags.check ? result.diff : "", typed.output]
        .filter((part) => part !== "")
        .join("\n");
      return {
        code: result.code === 0 ? typed.code : result.code,
        output,
        data: { files: result.files, summary: result.summary },
      };
    } catch (error) {
      phase.done();
      throw error;
    }
  },
});
