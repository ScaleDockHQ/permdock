import type * as Jiti from "jiti";
import type * as Oxc from "oxc-parser";

import { createRequire } from "node:module";

import { CliError } from "./errors.ts";
import { peerHint } from "./peer.ts";

const requireFrom = createRequire(import.meta.url);

function isMissing(error: unknown, name: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "MODULE_NOT_FOUND" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.includes(`'${name}'`)
  );
}

/**
 * Loads an optional peer synchronously, for the call sites that parse or
 * resolve inside a synchronous function. A missing peer fails with the install
 * line for the project's package manager.
 */
export function loadSync<T>(name: string, task: string): T {
  try {
    // SAFETY: `name` is one of the two optional peers this module types below.
    return requireFrom(name) as T;
  } catch (error) {
    if (!isMissing(error, name)) {
      throw error;
    }
    throw new CliError("unavailable", peerHint(name, task), {
      cause: error,
      code: "dependency_missing",
      extensions: { package: name },
    });
  }
}

/** `oxc-parser`, an optional peer that source scans and codemods need. */
export function oxc(): typeof Oxc {
  return loadSync<typeof Oxc>("oxc-parser", "reading source files");
}

/** `jiti`, an optional peer for project modules Node cannot import natively. */
export function jiti(): typeof Jiti {
  return loadSync<typeof Jiti>(
    "jiti",
    "loading a TypeScript module Node cannot import",
  );
}

/** `parseSync` from `oxc-parser`, loaded on first call. */
export function parseSync(
  ...args: Parameters<typeof Oxc.parseSync>
): Oxc.ParseResult {
  return oxc().parseSync(...args);
}

/** `new Visitor(visitor)` from `oxc-parser`, loaded on first call. */
export function createVisitor(visitor: Oxc.VisitorObject): Oxc.Visitor {
  return new (oxc().Visitor)(visitor);
}

/** The node types `Visitor` has a hook for. */
export function visitorKeyTypes(): readonly string[] {
  return Object.keys(oxc().visitorKeys);
}
