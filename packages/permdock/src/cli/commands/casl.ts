import type { Leaf } from "../core/command.ts";

import { defineLeaf } from "../core/command.ts";
import { fileOut, given, outFlag } from "../core/flags.ts";

export const caslImport: Leaf = defineLeaf({
  flags: {
    rules: {
      type: "string",
      description:
        "JSON of { [role]: rules }, each role's ability.rules or packRules output",
      valueHint: "file",
    },
    ...outFlag,
  },
  async run(ctx, { flags }) {
    // Lazy: the importer loads only when this command runs, not for --help.
    const { runCaslImport } = await import("../importers/casl.ts");
    return runCaslImport({
      cwd: ctx.cwd,
      rules: given(flags.rules),
      out: fileOut("casl import", flags.out),
      json: ctx.json,
    });
  },
});
