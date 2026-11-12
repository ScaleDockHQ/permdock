import type { PermDockPlugin } from "../generate/plugin.ts";
import type {
  ConstantsPluginOptions,
  GenKindPluginOptions,
} from "../generate/plugins/gen-kind.ts";

import { kindPlugin } from "../generate/plugins/gen-kind.ts";

export type { ConstantsPluginOptions, GenKindPluginOptions };

/**
 * Scope, role, permission and operation names and topic and path builders:
 * `constants.ts`, and `fields.ts` with `fields`.
 */
export function constants(
  options: ConstantsPluginOptions = {},
): PermDockPlugin {
  return kindPlugin("constants", options);
}

/**
 * The `<Resource>Row` types that the validator and factory modules import:
 * `types.ts`.
 */
export function types(options: GenKindPluginOptions = {}): PermDockPlugin {
  return kindPlugin("types", options);
}

/** The server-only SQL helper and table names: `sql.ts`. */
export function sql(options: GenKindPluginOptions = {}): PermDockPlugin {
  return kindPlugin("sql", options);
}

/** A row factory per resource for tests. Imports `permdock/testing`. */
export function factories(options: GenKindPluginOptions = {}): PermDockPlugin {
  return kindPlugin("factories", options);
}

/**
 * The `"use client"` bundle that a snapshot written with `omitStatic` points
 * into: `bundle.ts`.
 */
export function bundle(options: GenKindPluginOptions = {}): PermDockPlugin {
  return kindPlugin("bundle", options);
}

/** The `DescribeMessages` skeleton, which keeps translated values. */
export function messages(options: GenKindPluginOptions = {}): PermDockPlugin {
  return kindPlugin("messages", options);
}
