import type { PermDockPlugin } from "../plugin.ts";

import { definePlugin } from "../plugin.ts";
import { pluginVersion } from "./version.ts";

export type OpenApiPluginOptions = {
  /** The OpenAPI document to annotate. With none, the plugin emits nothing. */
  readonly doc?: string;
  readonly out?: string;
  /**
   * Glob of route modules. `generate --only openapi` emits their operations
   * map.
   */
  readonly routes?: string;
  /** Where the operations map is written. Default `src/operations.generated.ts`. */
  readonly operations?: string;
};

/**
 * Annotates an OpenAPI document. With no `doc` it emits nothing; the document
 * writer loads on emit when `doc` is set.
 */
export function openapi(options: OpenApiPluginOptions = {}): PermDockPlugin {
  const out = options.out ?? options.doc ?? "openapi.json";
  const operationsOut = options.operations ?? "src/operations.generated.ts";
  return definePlugin({
    name: "openapi",
    version: pluginVersion(),
    inputs: (ctx) => ({
      files: [
        ...(options.doc === undefined ? [] : [options.doc]),
        ...(options.routes === undefined ? [] : [options.routes]),
      ],
      options: { ...options, schemaDir: ctx.schemaDir },
    }),
    plan: () => [
      ...(options.doc === undefined ? [] : [{ id: "document", out }]),
      ...(options.routes === undefined
        ? []
        : [{ id: "operations", out: operationsOut }]),
    ],
    emit: async (task, _model, source) => {
      if (source === undefined) {
        return [];
      }
      if (task.id === "operations" && options.routes !== undefined) {
        // Lazy: route scanning loads only when the operations map is emitted.
        const { operationsFile } = await import("../../openapi/annotate.ts");
        return operationsFile(source.cwd, options.routes, task.out);
      }
      if (options.doc === undefined) {
        return [];
      }
      // Lazy: the document writer loads only when this plugin emits.
      const { openapiDocument } = await import("./openapi-document.ts");
      return openapiDocument(task, options, source);
    },
  });
}
