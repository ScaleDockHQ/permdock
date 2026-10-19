import { type Leaf, defineLeaf } from "../core/command.ts";
import { dryRunFlag } from "../core/flags.ts";

export const codemod: Leaf = defineLeaf({
  positionals: [
    {
      name: "version",
      description: "The release to migrate to (0.5)",
      required: true,
    },
    {
      name: "paths",
      description:
        "Files or directories to rewrite (default the working directory)",
      variadic: true,
    },
  ],
  flags: {
    ...dryRunFlag,
    force: {
      type: "boolean",
      description: "Rewrite files with uncommitted changes too",
    },
  },
  async run(ctx, { flags, args, rest }) {
    // Lazy: oxc-parser and the rename maps load only when this command runs, not for --help.
    const { runCodemod } = await import("../codemod/codemod.ts");
    return runCodemod({
      cwd: ctx.cwd,
      version: args["version"],
      paths: rest,
      dryRun: flags["dry-run"],
      force: flags.force,
      json: ctx.json,
    });
  },
});
