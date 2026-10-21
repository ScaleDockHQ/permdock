import type { Leaf } from "../core/command.ts";

import { defineLeaf } from "../core/command.ts";
import { checkFlag, dryRunFlag, given } from "../core/flags.ts";

export const generate: Leaf = defineLeaf({
  flags: {
    out: {
      type: "string",
      description:
        "File to write, - for stdout (default supabase/schemas/<schema>/scim.sql, else permdock_scim.sql)",
      valueHint: "file",
    },
    dialect: {
      type: "enum",
      options: ["supabase", "neon", "guc"],
      description:
        "Which client roles lose access to the tables (default rls.dialect, else supabase)",
    },
    schema: {
      type: "string",
      description:
        "Schema for the directory tables (default rls.schema, else permdock)",
      valueHint: "name",
    },
    ...checkFlag,
    ...dryRunFlag,
  },
  async run(ctx, { flags }) {
    const out = given(flags.out);
    const schema = given(flags.schema);
    // Lazy: the implementation loads only when this command runs, not for --help.
    const { runScimGenerate } = await import("../scim/generate.ts");
    return runScimGenerate({
      cwd: ctx.cwd,
      config: ctx.config,
      check: flags.check,
      dryRun: flags["dry-run"],
      ...(out === undefined ? {} : { out }),
      ...(schema === undefined ? {} : { schema }),
      ...(flags.dialect === undefined ? {} : { dialect: flags.dialect }),
    });
  },
});
