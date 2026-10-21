import { type Leaf, defineLeaf } from "../core/command.ts";
import { CliError } from "../core/errors.ts";
import { checkFlag, fileOut } from "../core/flags.ts";

export const collect: Leaf = defineLeaf({
  flags: {
    ...checkFlag,
    src: {
      type: "string",
      repeatable: true,
      description: "Source roots or globs",
      valueHint: "path",
    },
    out: {
      type: "string",
      description: "Catalog file to write",
      valueHint: "file",
    },
    watch: {
      type: "boolean",
      description: "Collect again when a source, config or policy file changes",
    },
  },
  async run(ctx, { flags }) {
    const out = fileOut("collect", flags.out);
    const overrides = {
      ...(flags.src.length > 0 ? { srcPath: [...flags.src] } : {}),
      ...(out === undefined ? {} : { out }),
    };
    if (flags.watch) {
      if (flags.check) {
        throw new CliError(
          "usage",
          "collect: --watch writes the catalog; drop --check",
          { code: "invalid_value" },
        );
      }
      // Lazy: the watcher loads only when this command runs, not for --help.
      const { watchCollect } = await import("../watch.ts");
      return watchCollect(ctx, overrides);
    }
    // Lazy: the implementation loads only when this command runs, not for --help.
    const result = await (
      await import("../collect.ts")
    ).runCollect({
      cwd: ctx.cwd,
      config: ctx.config,
      collect: overrides,
      check: flags.check,
      now: ctx.now,
      io: ctx.io,
    });
    return {
      code: result.code,
      output: result.message,
      ...(result.document === undefined
        ? {}
        : {
            data: {
              out: result.outPath,
              permissions: result.document.permissions.length,
              ...(flags.check ? { stale: result.code !== 0 } : {}),
              ...(result.positionsMoved === true
                ? { positionsMoved: true }
                : {}),
            },
          }),
    };
  },
});
