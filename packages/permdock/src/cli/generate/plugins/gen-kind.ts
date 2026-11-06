import type { GenKind } from "../../types.ts";
import type { PermDockPlugin } from "../plugin.ts";

import { definePlugin, noted } from "../plugin.ts";
import { pluginVersion } from "./version.ts";

export type GenKindPluginOptions = {
  /** The directory the module goes to; default `gen.out`, else `src/permdock`. */
  readonly dir?: string;
};

export type ZodPluginOptions = GenKindPluginOptions & {
  /** `zod/mini` for the functional, tree-shakeable Zod API; default `zod`. */
  readonly specifier?: "zod" | "zod/mini";
};

export type ConstantsPluginOptions = GenKindPluginOptions & {
  /** Also write `fields.ts`. */
  readonly fields?: boolean;
};

/** The kebab name each kind's plugin and file carry. */
const FILE: Readonly<Record<GenKind, string>> = {
  constants: "constants.ts",
  zod: "zod.ts",
  valibot: "valibot.ts",
  arktype: "arktype.ts",
  "json-schema": "json-schema.json",
  "standard-schema": "standard-schema.ts",
  factories: "factories.ts",
  react: "react.ts",
  vue: "vue.ts",
  svelte: "svelte.ts",
  solid: "solid.ts",
  messages: "messages.json",
};

const SCHEMA_KINDS: ReadonlySet<GenKind> = new Set([
  "zod",
  "valibot",
  "arktype",
  "json-schema",
  "standard-schema",
  "factories",
]);

/**
 * One typed-module kind as a generate plugin. The factory records options; the
 * renderer loads on emit, so importing a factory loads no emitter.
 */
export function kindPlugin(
  kind: GenKind,
  options: ZodPluginOptions & ConstantsPluginOptions = {},
): PermDockPlugin {
  const dir = options.dir ?? "src/permdock";
  return definePlugin({
    name: kind,
    version: pluginVersion(),
    after: kind === "constants" ? [] : ["constants"],
    inputs: () => ({ files: [], options }),
    plan: () => [{ id: kind, out: `${dir}/${FILE[kind]}` }],
    emit: async (_task, model, source) => {
      if (source === undefined) {
        return [];
      }
      // Lazy: the renderers load only when a typed-module plugin emits.
      const { renderKinds } = await import("../../gen/gen.ts");
      const files = await renderKinds({
        cwd: source.cwd,
        config: source.config,
        policy: source.policy,
        policyPath: source.config.policy ?? "",
        kinds: [kind],
        dir,
        ...(options.fields === undefined ? {} : { fields: options.fields }),
        ...(options.specifier === undefined
          ? {}
          : { zodSpecifier: options.specifier }),
      });
      const skipped = SCHEMA_KINDS.has(kind)
        ? model.resources.flatMap((resource) =>
            resource.schema === null &&
            source.policy.resources.get(resource.name)?.schema !== undefined
              ? [
                  `${kind}: resource '${resource.name}' has a schema with no JSON Schema export, so it is skipped`,
                ]
              : [],
          )
        : [];
      return noted(
        files.map((file) => ({ path: file.rel, contents: file.text })),
        skipped,
      );
    },
  });
}
