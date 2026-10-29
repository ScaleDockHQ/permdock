import { isRecord } from "../../core/compact.ts";
import { configError } from "./errors.ts";

/** An accepted finding: its id and why it stays. */
export type Ignore = { readonly id: string; readonly reason: string };

/**
 * Checks a config list of `{ id, reason }` and appends one entry per `--ignore`
 * id. `path` names the list in error messages, such as `doctor.ignore`.
 */
export function parseIgnores(
  entries: unknown,
  path: string,
  flags: readonly string[] = [],
): readonly Ignore[] {
  const list: unknown = entries ?? [];
  if (!Array.isArray(list)) {
    throw configError(`PermDock CLI: ${path} must be a list of { id, reason }`);
  }
  const out: Ignore[] = [];
  for (const [index, entry] of list.entries()) {
    if (
      !isRecord(entry) ||
      typeof entry["id"] !== "string" ||
      entry["id"] === "" ||
      typeof entry["reason"] !== "string" ||
      entry["reason"].trim() === ""
    ) {
      throw configError(
        `PermDock CLI: ${path}[${String(index)}] needs an id and a non-empty reason`,
      );
    }
    out.push({ id: entry["id"], reason: entry["reason"] });
  }
  for (const id of flags) {
    out.push({ id, reason: "--ignore" });
  }
  return out;
}

/**
 * Splits `items` by `ignores`; an id listed twice counts once, with its first
 * reason. `stale` holds the entries no item matched.
 */
export function splitIgnored<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  ignores: readonly Ignore[],
): {
  readonly kept: readonly T[];
  readonly ignored: readonly (Ignore & { readonly item: T })[];
  readonly stale: readonly Ignore[];
} {
  const reasons = new Map<string, string>();
  for (const entry of ignores) {
    if (!reasons.has(entry.id)) {
      reasons.set(entry.id, entry.reason);
    }
  }
  const matched = new Set<string>();
  const kept: T[] = [];
  const ignored: (Ignore & { readonly item: T })[] = [];
  for (const item of items) {
    const id = idOf(item);
    const reason = reasons.get(id);
    if (reason === undefined) {
      kept.push(item);
    } else {
      matched.add(id);
      ignored.push({ id, reason, item });
    }
  }
  const stale = [...reasons]
    .filter(([id]) => !matched.has(id))
    .map(([id, reason]) => ({ id, reason }));
  return { kept, ignored, stale };
}
