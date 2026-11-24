import type { Leaf } from "../core/command.ts";

import { defineLeaf } from "../core/command.ts";
import { CliError } from "../core/errors.ts";
import { dryRunFlag } from "../core/flags.ts";

export const codemod: Leaf = defineLeaf({
  positionals: [
    {
      name: "version",
      description:
        "The release to migrate to (0.5), config with --prune, manager-chain or bsb-access-tags",
      required: true,
      async complete() {
        // Lazy: oxc-parser and the rename maps load only when completion asks for them.
        return (await import("../codemod/codemod.ts")).codemodVersions();
      },
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
    prune: {
      type: "boolean",
      description:
        "With config: remove each key set to its default, after proving every generated file stays the same",
    },
    check: {
      type: "boolean",
      description: "With config --prune: exit 1 when a key would be removed",
    },
  },
  async run(ctx, { flags, args, rest }) {
    if (args["version"] === "config") {
      if (!flags.prune) {
        throw new CliError("usage", "codemod config needs --prune", {
          code: "invalid_value",
        });
      }
      // Lazy: the generators load only when the prune runs.
      return (await import("../codemod/prune-config.ts")).runPruneConfig({
        cwd: ctx.cwd,
        check: flags.check,
        dryRun: flags["dry-run"],
        force: flags.force,
        json: ctx.json,
      });
    }
    if (args["version"] === "bsb-access-tags") {
      // Lazy: the SQL parser and better-supabase/sql load only when the codemod runs.
      return (await import("../codemod/bsb-access-tags.ts")).runAccessTags({
        cwd: ctx.cwd,
        ...(rest[0] === undefined ? {} : { schemas: rest[0] }),
        dryRun: flags["dry-run"],
        force: flags.force,
        json: ctx.json,
      });
    }
    if (args["version"] === "manager-chain") {
      // Lazy: the SQL parser loads only when the codemod runs.
      return (await import("../codemod/manager-chain.ts")).runManagerChain({
        cwd: ctx.cwd,
        ...(rest[0] === undefined ? {} : { schemas: rest[0] }),
        dryRun: flags["dry-run"],
        force: flags.force,
        json: ctx.json,
      });
    }
    // Lazy: oxc-parser and the rename maps load only when this command runs, not for --help.
    return (await import("../codemod/codemod.ts")).runCodemod({
      cwd: ctx.cwd,
      version: args["version"],
      paths: rest,
      dryRun: flags["dry-run"],
      force: flags.force,
      json: ctx.json,
    });
  },
});
