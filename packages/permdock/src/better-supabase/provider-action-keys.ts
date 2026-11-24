import type { AuthorizationProvider } from "better-supabase/contract";

import type { CatalogDocument } from "../catalog/types.ts";
import type { AnswerKind } from "../core/action-answers.ts";

import { parseAnswer } from "../core/action-answers.ts";

type ActionKeys = NonNullable<AuthorizationProvider["actionKeys"]>;

/**
 * better-supabase's `actionKeys` from the catalog's `answers`. An action two
 * permissions answer is left out, so better-supabase falls back to the config
 * or the block's own key, and `problems` names both keys.
 */
export function actionKeysOf(
  catalog: CatalogDocument,
  problems: string[],
): ActionKeys | undefined {
  const keys = new Map<AnswerKind, Map<string, Map<string, string>>>();
  const clashes = new Set<string>();
  for (const permission of catalog.permissions) {
    for (const entry of permission.answers ?? []) {
      const answer = parseAnswer(entry);
      if (answer === undefined) {
        problems.push(
          `${permission.key} answers ${entry}, which is not <blocks|recordTypes|buckets|topics>.<name>.<action>.`,
        );
        continue;
      }
      const names =
        keys.get(answer.kind) ?? new Map<string, Map<string, string>>();
      keys.set(answer.kind, names);
      const actions = names.get(answer.name) ?? new Map<string, string>();
      names.set(answer.name, actions);
      const held = actions.get(answer.action);
      if (held !== undefined && held !== permission.key) {
        problems.push(
          `${entry} is answered by both ${held} and ${permission.key}; it is left out of actionKeys.`,
        );
        clashes.add(entry);
      }
      actions.set(answer.action, held ?? permission.key);
    }
  }
  const out: { [K in AnswerKind]?: Record<string, Record<string, string>> } =
    {};
  for (const [kind, names] of keys) {
    const byName: Record<string, Record<string, string>> = {};
    for (const [name, actions] of [...names].toSorted(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      const kept = [...actions]
        .filter(([action]) => !clashes.has(`${kind}.${name}.${action}`))
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (kept.length > 0) byName[name] = Object.fromEntries(kept);
    }
    if (Object.keys(byName).length > 0) out[kind] = byName;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
