import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { AnswerKind } from "../../core/action-answers.ts";

import { isRecord } from "../../core/compact.ts";

/**
 * One action better-supabase checks, as `listActions` from
 * `better-supabase/sql` lists it.
 */
export type BsbAction = {
  readonly kind: "block" | "recordType" | "bucket" | "topic";
  readonly name: string;
  readonly action: string;
  readonly key: string | null;
  readonly source: "config" | "provider" | "default";
};

export type BsbActions =
  | { readonly kind: "actions"; readonly actions: readonly BsbAction[] }
  /** better-supabase does not resolve from the project. */
  | { readonly kind: "missing" }
  /** It resolves without `listActions` or `loadConfig` (before 0.84.0). */
  | { readonly kind: "old" }
  /** `loadConfig` refused the config. */
  | { readonly kind: "invalid"; readonly message: string };

const KINDS: ReadonlySet<unknown> = new Set([
  "block",
  "recordType",
  "bucket",
  "topic",
]);
const SOURCES: ReadonlySet<unknown> = new Set([
  "config",
  "provider",
  "default",
]);

const ANSWER_KIND: Readonly<Record<BsbAction["kind"], AnswerKind>> = {
  block: "blocks",
  recordType: "recordTypes",
  bucket: "buckets",
  topic: "topics",
};

/** `blocks.audit.read`: the `meta.answers` entry that answers `action`. */
export function answerOf(action: BsbAction): string {
  return `${ANSWER_KIND[action.kind]}.${action.name}.${action.action}`;
}

function isAction(value: unknown): value is BsbAction {
  return (
    isRecord(value) &&
    KINDS.has(value["kind"]) &&
    typeof value["name"] === "string" &&
    typeof value["action"] === "string" &&
    (value["key"] === null || typeof value["key"] === "string") &&
    SOURCES.has(value["source"])
  );
}

type LoadConfig = (cwd: string, explicit?: string) => Promise<unknown>;
type ListActions = (config: unknown) => unknown;

function isFunction<T>(value: unknown): value is T {
  return typeof value === "function";
}

/**
 * Every action the better-supabase config at `path` makes better-supabase
 * check, from the project's own `better-supabase/cli` `loadConfig` and
 * `better-supabase/sql` `listActions` (0.84.0).
 */
export async function bsbActions(
  cwd: string,
  path: string,
): Promise<BsbActions> {
  let cli: Record<string, unknown>;
  let sql: Record<string, unknown>;
  try {
    const require = createRequire(resolve(cwd, "package.json"));
    // Optional peer: only a project with a better-supabase config reaches it.
    cli = await import(
      pathToFileURL(require.resolve("better-supabase/cli")).href
    );
    // Optional peer: only a project with a better-supabase config reaches it.
    sql = await import(
      pathToFileURL(require.resolve("better-supabase/sql")).href
    );
  } catch {
    return { kind: "missing" };
  }
  const load = cli["loadConfig"];
  const list = sql["listActions"];
  if (!isFunction<LoadConfig>(load) || !isFunction<ListActions>(list)) {
    return { kind: "old" };
  }
  let listed: unknown;
  try {
    listed = list(await load(dirname(path), path));
  } catch (error) {
    return {
      kind: "invalid",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    kind: "actions",
    actions: Array.isArray(listed) ? listed.filter(isAction) : [],
  };
}
