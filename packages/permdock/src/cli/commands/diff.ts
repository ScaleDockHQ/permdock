import { type Leaf, defineLeaf } from "../core/command.ts";
import { given } from "../core/flags.ts";

export const diff: Leaf = defineLeaf({
  positionals: [
    {
      name: "before",
      description:
        "A permissions.catalog.json or a module exporting policy (default the committed catalog)",
    },
    {
      name: "after",
      description: "The same, for the new side (default the working tree)",
    },
  ],
  flags: {
    impact: {
      type: "boolean",
      description:
        "Run the fixtures through both sides and report changed outcomes",
    },
    fixtures: {
      type: "string",
      description: "Fixtures file for --impact",
      valueHint: "file",
    },
  },
  async run(ctx, { flags, args }) {
    // Lazy: the implementation loads only when this command runs, not for --help.
    return (await import("../diff/diff.ts")).runDiff({
      cwd: ctx.cwd,
      config: ctx.config,
      sources: [args["before"], args["after"]].filter(
        (value) => value !== undefined,
      ),
      impact: flags.impact,
      fixtures: given(flags.fixtures),
      json: ctx.json,
      now: ctx.now,
      io: ctx.io,
    });
  },
});
