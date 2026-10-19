import { type Leaf, defineLeaf } from "../core/command.ts";
import { fileOut, given, outFlag } from "../core/flags.ts";

export const casbinImport: Leaf = defineLeaf({
  flags: {
    model: {
      type: "string",
      description: "The Casbin model.conf",
      valueHint: "file",
    },
    policy: {
      type: "string",
      description: "The Casbin policy.csv",
      valueHint: "file",
    },
    ...outFlag,
  },
  async run(ctx, { flags }) {
    // Lazy: the importer loads only when this command runs, not for --help.
    const { runCasbinImport } = await import("../importers/casbin.ts");
    return runCasbinImport({
      cwd: ctx.cwd,
      model: given(flags.model),
      policy: given(flags.policy),
      out: fileOut("casbin import", flags.out),
      json: ctx.json,
    });
  },
});
