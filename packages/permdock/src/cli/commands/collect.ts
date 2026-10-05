import { defineCommand } from "citty";

import {
  type CliContext,
  type Command,
  globalArgs,
  listArg,
  stringArg,
} from "./context.ts";
import { COMMAND_DESCRIPTIONS } from "./index.ts";

export function collect(ctx: CliContext): Command {
  const command = defineCommand({
    meta: {
      name: "collect",
      description: COMMAND_DESCRIPTIONS.collect,
    },
    args: {
      ...globalArgs,
      check: {
        type: "boolean",
        description: "Exit 1 when the catalog on disk is stale; write nothing",
      },
      src: {
        type: "string",
        description: "Source roots or globs, repeatable or comma-separated",
        valueHint: "path",
      },
      out: {
        type: "string",
        description: "Catalog file to write",
        valueHint: "file",
      },
      watch: {
        type: "boolean",
        description:
          "Collect again when a source, config or policy file changes",
      },
    },
    async run({ args: parsed, rawArgs }) {
      const src = listArg(rawArgs, "src");
      const out = stringArg(parsed.out);
      const overrides = {
        ...(src.length > 0 ? { srcPath: src } : {}),
        ...(out === undefined ? {} : { out }),
      };
      if (parsed.watch === true) {
        if (parsed.check === true) {
          ctx.report({
            code: 2,
            output: "collect: --watch writes the catalog; drop --check",
          });
          return;
        }
        // Lazy: the watcher loads only when this command runs, not for --help.
        const { createCollectScheduler } = await import("../watch.ts");
        const scheduler = createCollectScheduler(
          ctx.cwd,
          { collect: overrides },
          {
            ...(ctx.configFile === undefined
              ? {}
              : { configFile: ctx.configFile }),
            report: (message) => {
              ctx.io.stderr(message ?? "catalog updated");
            },
          },
        );
        let message: string | undefined;
        try {
          message = await scheduler.run(false);
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        scheduler.watch();
        ctx.report({
          code: 0,
          output: message ?? "watching for changes; Ctrl-C to stop",
        });
        return;
      }
      // Lazy: the implementation loads only when this command runs, not for --help.
      const result = await (
        await import("../collect.ts")
      ).runCollect({
        cwd: ctx.cwd,
        config: ctx.config,
        collect: overrides,
        check: parsed.check === true,
        now: ctx.now,
        io: ctx.io,
      });
      ctx.report({ code: result.code, output: result.message });
    },
  });
  return command;
}
