import type { PermDockPlugin } from "../generate/plugin.ts";
import type {
  GenKindPluginOptions,
  ZodPluginOptions,
} from "../generate/plugins/gen-kind.ts";

import { kindPlugin } from "../generate/plugins/gen-kind.ts";

export type { GenKindPluginOptions, ZodPluginOptions };

/** Row validators as Zod schemas, from the model's JSON Schema. */
export function zod(options: ZodPluginOptions = {}): PermDockPlugin {
  return kindPlugin("zod", options);
}

/** Row validators as Valibot schemas. */
export function valibot(options: GenKindPluginOptions = {}): PermDockPlugin {
  return kindPlugin("valibot", options);
}

/** Row validators as ArkType types. */
export function arktype(options: GenKindPluginOptions = {}): PermDockPlugin {
  return kindPlugin("arktype", options);
}

/** The row JSON Schemas as one document. */
export function jsonSchema(options: GenKindPluginOptions = {}): PermDockPlugin {
  return kindPlugin("json-schema", options);
}

/** Row validators over the JSON Schema core, with no validator library. */
export function standardSchema(
  options: GenKindPluginOptions = {},
): PermDockPlugin {
  return kindPlugin("standard-schema", options);
}
