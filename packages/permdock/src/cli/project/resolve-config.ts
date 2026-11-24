import { isDeepStrictEqual } from "node:util";

import type { PermDockConfig } from "../types.ts";

import { supabaseMembershipsBudget } from "../../supabase/budget.ts";
import { PERMDOCK_SCHEMA } from "../../supabase/sources.ts";
import { defaultSrcPath } from "../files.ts";
import {
  DEFAULT_SENSITIVE_ACTIONS,
  MIGRATION_DIRS,
} from "../shared/constants.ts";

/** The sections `resolveConfig` fills. */
export type ResolvedSection =
  | "rls"
  | "supabase.hook"
  | "gen"
  | "collect"
  | "doctor";

/**
 * One config key, its path from the root and the value a command uses when it
 * is unset.
 */
export type ConfigDefault = {
  readonly section: ResolvedSection;
  readonly path: readonly string[];
  readonly value: unknown;
};

/**
 * Each default a command applies to an unset key. A default that depends on
 * another key (the broadcast topic follows the token hook's owner) is not
 * listed, because a value equal to it in one project differs in another.
 */
const CONFIG_DEFAULTS: readonly ConfigDefault[] = Object.freeze([
  { section: "rls", path: ["rls", "dialect"], value: "supabase" },
  { section: "rls", path: ["rls", "schema"], value: PERMDOCK_SCHEMA },
  { section: "rls", path: ["rls", "gucPrefix"], value: "app" },
  { section: "rls", path: ["rls", "roleClaim"], value: "user_role" },
  { section: "rls", path: ["rls", "fixtures"], value: "rls.fixtures.json" },
  { section: "rls", path: ["rls", "out"], value: "rls.sql" },
  { section: "rls", path: ["rls", "memo"], value: "none" },
  {
    section: "supabase.hook",
    path: ["supabase", "hook", "out"],
    value: "supabase/permdock-hook.sql",
  },
  {
    section: "supabase.hook",
    path: ["supabase", "hook", "jwtExpiry"],
    value: 900,
  },
  {
    section: "supabase.hook",
    path: ["supabase", "hook", "security"],
    value: "invoker",
  },
  {
    section: "supabase.hook",
    path: ["supabase", "hook", "refresh"],
    value: "reuse",
  },
  {
    section: "supabase.hook",
    path: ["supabase", "hook", "oauth"],
    value: "full",
  },
  {
    section: "supabase.hook",
    path: ["supabase", "hook", "membershipsClaim"],
    value: true,
  },
  {
    section: "supabase.hook",
    path: ["supabase", "hook", "budget"],
    value: supabaseMembershipsBudget,
  },
  {
    section: "supabase.hook",
    path: ["supabase", "hook", "broadcast", "receivePolicy"],
    value: true,
  },
  { section: "gen", path: ["gen", "out"], value: "src/permdock" },
  { section: "gen", path: ["gen", "zod", "specifier"], value: "zod" },
  { section: "collect", path: ["collect", "srcPath"], value: defaultSrcPath() },
  { section: "doctor", path: ["doctor", "migrations"], value: MIGRATION_DIRS },
  {
    section: "doctor",
    path: ["doctor", "sensitiveActions"],
    value: DEFAULT_SENSITIVE_ACTIONS,
  },
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const key of path) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

/**
 * `value` in the form two equal settings share: object keys sorted, and a list
 * of strings sorted when its order does not matter to the command. Whitespace
 * runs in a string collapse, so an SQL template that differs only in layout is
 * equal.
 */
function normalisedValue(value: unknown, unordered = false): unknown {
  if (typeof value === "string") {
    return value.replaceAll(/\s+/gu, " ").trim();
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => normalisedValue(item));
    return unordered && items.every((item) => typeof item === "string")
      ? items.toSorted()
      : items;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, normalisedValue(value[key])]),
    );
  }
  return value;
}

/** Lists whose order no command reads. */
const UNORDERED: ReadonlySet<string> = new Set([
  "doctor.migrations",
  "doctor.sensitiveActions",
  "collect.srcPath",
]);

function withValue(
  root: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = path;
  if (head === undefined) {
    return root;
  }
  const current = root[head];
  return {
    ...root,
    [head]:
      rest.length === 0
        ? value
        : withValue(isRecord(current) ? current : {}, rest, value),
  };
}

/** `root` without the key at `path`; an object left empty stays. */
export function withoutPath(
  root: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> {
  const [head, ...rest] = path;
  if (head === undefined || !Object.hasOwn(root, head)) {
    return root;
  }
  if (rest.length === 0) {
    return Object.fromEntries(
      Object.entries(root).filter(([key]) => key !== head),
    );
  }
  const current = root[head];
  return isRecord(current)
    ? { ...root, [head]: withoutPath(current, rest) }
    : root;
}

/**
 * The config each command reads: every unset key in a configured section filled
 * with its default. `defaults` names the keys the defaults filled. A section
 * the config does not open (no `rls`, no `supabase.hook`) stays unset, because
 * opening it turns a command on.
 */
export function resolveConfig(config: PermDockConfig): {
  readonly value: PermDockConfig;
  readonly defaults: readonly string[];
} {
  // SAFETY: PermDockConfig is a plain object type; the cast reads it as a record to walk its keys.
  let value = config as unknown as Record<string, unknown>;
  const defaults: string[] = [];
  for (const entry of CONFIG_DEFAULTS) {
    const sectionPath =
      entry.section === "supabase.hook"
        ? ["supabase", "hook"]
        : [entry.section];
    if (valueAt(value, sectionPath) === undefined) {
      continue;
    }
    if (valueAt(value, entry.path) !== undefined) {
      continue;
    }
    value = withValue(value, entry.path, entry.value);
    defaults.push(entry.path.join("."));
  }
  // SAFETY: withValue only adds keys whose values come from CONFIG_DEFAULTS, which match PermDockConfig.
  return { value: value as PermDockConfig, defaults };
}

/** The keys `config` sets to the value their command would use anyway. */
export function restatedDefaults(
  config: PermDockConfig,
): readonly ConfigDefault[] {
  return CONFIG_DEFAULTS.filter((entry) => {
    const value = valueAt(config, entry.path);
    if (value === undefined) {
      return false;
    }
    const unordered = UNORDERED.has(entry.path.join("."));
    return isDeepStrictEqual(
      normalisedValue(value, unordered),
      normalisedValue(entry.value, unordered),
    );
  });
}
