import type { PermDockConfig } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
import { CliError, configError } from "../core/errors.ts";
import {
  CONFIG_SHAPE,
  MODULE_KEYS,
  describeKinds,
  isModuleKey,
  isSection,
  kindOf,
} from "./config-shape.ts";

const TOP_LEVEL: ReadonlySet<string> = new Set<string>([
  ...Object.keys(MODULE_KEYS),
  ...Object.keys(CONFIG_SHAPE),
]);

export type ParsedConfig = {
  readonly config: PermDockConfig;
  /** Keys PermDock does not read, as `path: message`; a typo lands here. */
  readonly warnings: readonly string[];
};

function invalid(file: string, message: string): CliError {
  return new CliError("usage", `PermDock CLI: ${file}: ${message}`);
}

/**
 * Checks the shape a command relies on before it reads the config: module paths
 * are strings, each section is an object, and each key PermDock reads holds a
 * value of a kind it accepts. A key PermDock does not read is a warning, so a
 * config written for a newer version still loads.
 */
export function parseConfig(value: unknown, file: string): ParsedConfig {
  if (value === undefined) {
    return { config: {}, warnings: [] };
  }
  if (!isRecord(value)) {
    throw new CliError(
      "usage",
      `PermDock CLI: ${file} must export a config object as default (use defineConfig)`,
    );
  }
  const warnings: string[] = [];
  const unknown = (path: string, known: Iterable<string>): string =>
    `${file}: unknown key ${path}; PermDock reads ${[...known].join(", ")}`;
  for (const [key, entry] of Object.entries(value)) {
    if (isModuleKey(key)) {
      if (entry !== undefined && typeof entry !== "string") {
        throw invalid(
          file,
          `${key} must be a module path string or the value imported from it`,
        );
      }
      continue;
    }
    if (!isSection(key)) {
      warnings.push(unknown(key, TOP_LEVEL));
      continue;
    }
    if (entry === undefined) {
      continue;
    }
    if (!isRecord(entry)) {
      throw invalid(file, `${key} must be an object`);
    }
    const known = CONFIG_SHAPE[key];
    for (const [child, childValue] of Object.entries(entry)) {
      const kinds = Object.hasOwn(known, child) ? known[child] : undefined;
      if (kinds === undefined) {
        warnings.push(unknown(`${key}.${child}`, Object.keys(known)));
        continue;
      }
      const kind = kindOf(childValue);
      if (
        childValue !== undefined &&
        (kind === undefined || !kinds.includes(kind))
      ) {
        throw configError(
          `PermDock CLI: ${file}: ${key}.${child} must be ${describeKinds(kinds)}, not ${kind === undefined ? "null" : describeKinds([kind])}`,
        );
      }
    }
  }
  // SAFETY: module paths, section shapes and the kind of every known key were checked above; deeper values are the project's to type with defineConfig.
  return { config: value as PermDockConfig, warnings };
}
