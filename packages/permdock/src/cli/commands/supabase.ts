import { type Leaf, defineLeaf } from "../core/command.ts";
import { checkFlag, dbUrl, dbUrlFlags, fileOut, given } from "../core/flags.ts";

export const hookGenerate: Leaf = defineLeaf({
  flags: {
    out: { type: "string", description: "File to write", valueHint: "file" },
    ...checkFlag,
    ...dbUrlFlags,
    "active-from": {
      type: "string",
      description: "Where the hook reads the active tenant",
      valueHint: "source",
    },
    budget: {
      type: "string",
      description: "Byte budget for the memberships claim",
      valueHint: "bytes",
    },
    schema: {
      type: "string",
      description: "Schema for the hook function",
      valueHint: "name",
    },
    schemas: {
      type: "enum",
      options: ["pg-delta", "migra", "migrations"],
      description: "Schema workflow (default supabase.schemas, else pg-delta)",
    },
    "grants-out": {
      type: "string",
      description: "migra: file for the privileges supabase db diff drops",
      valueHint: "file",
    },
  },
  async run(ctx, { flags }) {
    const out = fileOut("supabase hook generate", flags.out);
    const db = await dbUrl(ctx, flags);
    const activeFrom = given(flags["active-from"]);
    const budget = given(flags.budget);
    const schema = given(flags.schema);
    const grantsOut = given(flags["grants-out"]);
    // Lazy: the implementation loads only when this command runs, not for --help.
    const { runSupabase } = await import("../supabase-hook/supabase-hook.ts");
    return runSupabase({
      cwd: ctx.cwd,
      config: ctx.config,
      rest: ["hook", "generate"],
      check: flags.check,
      json: ctx.json,
      io: ctx.io,
      ...(out === undefined ? {} : { out }),
      ...(db === undefined ? {} : { db }),
      ...(activeFrom === undefined ? {} : { activeFrom }),
      ...(budget === undefined ? {} : { budget }),
      ...(schema === undefined ? {} : { schema }),
      ...(grantsOut === undefined ? {} : { grantsOut }),
      ...(flags.schemas === undefined ? {} : { schemas: flags.schemas }),
    });
  },
});

export const inspect: Leaf = defineLeaf({
  flags: {
    out: {
      type: "string",
      description: "File to write; a bare --out writes permdock.manifest.json",
      valueHint: "file",
    },
    ...checkFlag,
  },
  async run(ctx, { flags }) {
    const out =
      flags.out === "" ? true : flags.out === "-" ? undefined : flags.out;
    // Lazy: the implementation loads only when this command runs, not for --help.
    const { runSupabase } = await import("../supabase-hook/supabase-hook.ts");
    return runSupabase({
      cwd: ctx.cwd,
      config: ctx.config,
      rest: ["inspect"],
      check: flags.check,
      json: ctx.json,
      io: ctx.io,
      ...(out === undefined ? {} : { out }),
    });
  },
});
