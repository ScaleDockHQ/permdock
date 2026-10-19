import { type Leaf, defineLeaf } from "../core/command.ts";
import { failOnFlag } from "../core/flags.ts";

export const config: Leaf = defineLeaf({
  flags: {
    print: {
      type: "boolean",
      description:
        "Print the effective config as JSON: the file, as written, and each default",
    },
    ...failOnFlag,
  },
  async run(ctx, { flags }) {
    // Lazy: the implementation loads only when this command runs, not for --help.
    const { runConfig } = await import("../config-report.ts");
    return runConfig({
      cwd: ctx.cwd,
      config: ctx.config,
      file: ctx.configPath,
      warnings: ctx.configWarnings,
      print: flags.print,
      json: ctx.json,
      strict: flags["fail-on"] === "warning",
    });
  },
});
