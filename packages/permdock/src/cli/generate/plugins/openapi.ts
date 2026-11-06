import type { PermDockPlugin } from "../plugin.ts";

import { definePlugin } from "../plugin.ts";
import { pluginVersion } from "./version.ts";

export type OpenApiPluginOptions = {
  /** The OpenAPI document to annotate. With none, the plugin emits nothing. */
  readonly doc?: string;
  readonly out?: string;
};

/**
 * Annotates an OpenAPI document. With no `doc` it emits nothing; the document
 * writer loads on emit when `doc` is set.
 */
export function openapi(options: OpenApiPluginOptions = {}): PermDockPlugin {
  const out = options.out ?? options.doc ?? "openapi.json";
  return definePlugin({
    name: "openapi",
    version: pluginVersion(),
    inputs: (ctx) => ({
      files: options.doc === undefined ? [] : [options.doc],
      options: { ...options, schemaDir: ctx.schemaDir },
    }),
    plan: () => (options.doc === undefined ? [] : [{ id: "document", out }]),
    emit: async (task, _model, source) => {
      if (source === undefined || options.doc === undefined) {
        return [];
      }
      // Lazy: the document writer loads only when this plugin emits.
      const { openapiDocument } = await import("./openapi-document.ts");
      return openapiDocument(task, options, source);
    },
  });
}
