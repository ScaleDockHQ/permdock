import { type Leaf, defineLeaf } from "../core/command.ts";
import {
  checkFlag,
  dbUrl,
  dbUrlFlags,
  fileOut,
  given,
  policyFlag,
} from "../core/flags.ts";

export const generate: Leaf = defineLeaf({
  flags: {
    out: {
      type: "string",
      description: "The Sync Streams file (default sync-config.yaml)",
      valueHint: "file",
    },
    ...checkFlag,
    ...policyFlag,
  },
  async run(ctx, { flags }) {
    const out = fileOut("powersync", flags.out);
    const from = given(flags.policy);
    // Lazy: the implementation loads only when this command runs, not for --help.
    const { runPowerSync } = await import("../powersync/powersync.ts");
    return runPowerSync({
      cwd: ctx.cwd,
      config: ctx.config,
      rest: ["generate"],
      check: flags.check,
      ...(out === undefined ? {} : { out }),
      ...(from === undefined ? {} : { from }),
    });
  },
});

export const verify: Leaf = defineLeaf({
  flags: {
    out: {
      type: "string",
      description: "The Sync Streams file to verify (default sync-config.yaml)",
      valueHint: "file",
    },
    ...dbUrlFlags,
    fixtures: {
      type: "string",
      description: "Fixtures file (default rls.fixtures.json)",
      valueHint: "file",
    },
    ...policyFlag,
  },
  async run(ctx, { flags }) {
    const out = fileOut("powersync", flags.out);
    const db = await dbUrl(ctx, flags, { required: true });
    const fixtures = given(flags.fixtures);
    const from = given(flags.policy);
    // Lazy: the implementation loads only when this command runs, not for --help.
    const { runPowerSync } = await import("../powersync/powersync.ts");
    return runPowerSync({
      cwd: ctx.cwd,
      config: ctx.config,
      rest: ["verify"],
      check: false,
      ...(out === undefined ? {} : { out }),
      ...(db === undefined ? {} : { db }),
      ...(fixtures === undefined ? {} : { fixtures }),
      ...(from === undefined ? {} : { from }),
    });
  },
});
