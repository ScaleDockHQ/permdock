import type { Leaf } from "../core/command.ts";

import { defineLeaf } from "../core/command.ts";
import { checkFlag, dryRunFlag, given, policyFlag } from "../core/flags.ts";

export const gen: Leaf = defineLeaf({
  flags: {
    kind: {
      type: "enum",
      options: [
        "constants",
        "zod",
        "valibot",
        "arktype",
        "json-schema",
        "standard-schema",
        "factories",
        "react",
        "vue",
        "svelte",
        "solid",
        "messages",
      ],
      repeatable: true,
      description: "What to write (default gen.kinds, else constants)",
      valueHint: "kind",
    },
    out: {
      type: "string",
      description: "File for a single kind (- for stdout)",
      valueHint: "file",
    },
    "out-dir": {
      type: "string",
      description:
        "Directory for the files (default gen.out, else src/generated)",
      valueHint: "dir",
    },
    ...checkFlag,
    ...dryRunFlag,
    ...policyFlag,
  },
  async run(ctx, { flags }) {
    const out = given(flags.out);
    const outDir = given(flags["out-dir"]);
    const from = given(flags.policy);
    // Lazy: the implementation loads only when this command runs, not for --help.
    const { runGen } = await import("../gen/gen.ts");
    return runGen({
      cwd: ctx.cwd,
      config: ctx.config,
      kinds: flags.kind,
      check: flags.check,
      dryRun: flags["dry-run"],
      ...(out === undefined ? {} : { out }),
      ...(outDir === undefined ? {} : { outDir }),
      ...(from === undefined ? {} : { from }),
    });
  },
});
