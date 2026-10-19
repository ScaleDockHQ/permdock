import { type Leaf, defineLeaf } from "../core/command.ts";
import { missingInput } from "../core/errors.ts";
import { checkFlag, given, outFlag, permissionsFlag } from "../core/flags.ts";

const RUN_FORMAT = {
  catalog: "json",
  "json-schema": "schema",
  markdown: "markdown",
} as const;

export const catalog: Leaf = defineLeaf({
  flags: {
    kind: {
      type: "enum",
      options: ["catalog", "json-schema", "markdown"],
      default: "catalog",
      description:
        "What to print: the catalog, its JSON Schema, or a Markdown table",
    },
    ...permissionsFlag,
    include: {
      type: "string",
      repeatable: true,
      description: "Permission keys or prefixes to keep",
      valueHint: "key",
    },
    ...outFlag,
    ...checkFlag,
  },
  async run(ctx, { flags }) {
    // Lazy: the implementation loads only when this command runs, not for --help.
    const { catalogFile, runCatalog } = await import("../catalog.ts");
    const result = await runCatalog({
      cwd: ctx.cwd,
      config: ctx.config,
      format: RUN_FORMAT[flags.kind],
      from: given(flags.permissions),
      include: flags.include,
      now: ctx.now,
      io: ctx.io,
    });
    const out = given(flags.out);
    if (out === undefined) {
      if (flags.check) {
        throw missingInput("catalog --check", ["--out"], "the file to compare");
      }
      return result;
    }
    return result.code === 0
      ? catalogFile(ctx.cwd, out, result.output, flags.check)
      : result;
  },
});
