import type { Leaf } from "../core/command.ts";

import { defineLeaf } from "../core/command.ts";
import { dryRunFlag, given } from "../core/flags.ts";

export const keysRename: Leaf = defineLeaf({
  positionals: [
    {
      name: "from",
      description: "The permission key to retire, such as fileNode.read",
      required: true,
    },
    {
      name: "to",
      description:
        "The key that replaces it, such as file.read; an existing key merges",
      required: true,
    },
  ],
  flags: {
    ...dryRunFlag,
    force: {
      type: "boolean",
      description:
        "Rewrite the permissions module with uncommitted changes too",
    },
    migration: {
      type: "string",
      description:
        "Data migration to write (default <migrations dir>/<timestamp>_permdock_keys_rename.sql)",
      valueHint: "file",
    },
  },
  async run(ctx, { flags, args }) {
    // Lazy: oxc-parser and the project's permissions load only when this command runs.
    const { runKeysRename } = await import("../keys/rename.ts");
    const migration = given(flags.migration);
    return runKeysRename({
      cwd: ctx.cwd,
      config: ctx.config,
      from: args["from"] ?? "",
      to: args["to"] ?? "",
      ...(migration === undefined ? {} : { migration }),
      dryRun: flags["dry-run"],
      force: flags.force,
      json: ctx.json,
      now: ctx.now,
    });
  },
});
