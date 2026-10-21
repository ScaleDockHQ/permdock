import type { Leaf } from "../core/command.ts";

import { defineLeaf } from "../core/command.ts";
import { failOnFlag } from "../core/flags.ts";

export const usage: Leaf = defineLeaf({
  flags: {
    ...failOnFlag,
    ignore: {
      type: "string",
      repeatable: true,
      description: "Permission keys or globs to skip",
      valueHint: "glob",
    },
    "dynamic-as-used": {
      type: "boolean",
      description: "Count computed permission references as uses",
    },
  },
  async run(ctx, { flags }) {
    // Lazy: the implementation loads only when this command runs, not for --help.
    return (await import("../usage.ts")).runUsage({
      cwd: ctx.cwd,
      config: ctx.config,
      ignore: flags.ignore,
      strict: flags["fail-on"] === "warning",
      json: ctx.json,
      dynamicAsUsed: flags["dynamic-as-used"],
      now: ctx.now,
      io: ctx.io,
    });
  },
});
