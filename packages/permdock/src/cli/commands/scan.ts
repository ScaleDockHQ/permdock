import { type Leaf, defineLeaf } from "../core/command.ts";

export const scan: Leaf = defineLeaf({
  flags: {
    pattern: {
      type: "string",
      repeatable: true,
      description: "An extra regular expression to report",
      valueHint: "regex",
    },
    src: {
      type: "string",
      repeatable: true,
      description: "Directories to scan (default collect.srcPath or src)",
      valueHint: "dir",
    },
  },
  async run(ctx, { flags }) {
    // Lazy: the implementation loads only when this command runs, not for --help.
    const { runLegacyScan } = await import("../legacy-scan.ts");
    return runLegacyScan({
      cwd: ctx.cwd,
      srcPath:
        flags.src.length > 0
          ? flags.src
          : (ctx.config.collect?.srcPath ?? ["src"]),
      patterns: flags.pattern,
      json: ctx.json,
    });
  },
});
