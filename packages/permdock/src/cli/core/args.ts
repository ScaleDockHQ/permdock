import type { ArgsDef } from "citty";

import { closest, distance } from "fastest-levenshtein";

/** The closest name within an edit distance of 2, or `undefined`. */
export function didYouMean(
  given: string,
  names: readonly string[],
): string | undefined {
  if (names.length === 0) {
    return undefined;
  }
  const best = closest(given, [...names]);
  return distance(given, best) <= Math.max(2, Math.floor(given.length / 3))
    ? best
    : undefined;
}

/** Every `--name` and `-x` spelling a definition accepts, negations included. */
export function flagSpellings(def: ArgsDef): ReadonlySet<string> {
  const names = new Set<string>(["--help", "-h"]);
  for (const [name, arg] of Object.entries(def)) {
    if (arg.type === "positional") {
      continue;
    }
    names.add(`--${name}`);
    if (arg.type === "boolean") {
      names.add(`--no-${name}`);
    }
    const aliases =
      "alias" in arg && arg.alias !== undefined ? [arg.alias].flat() : [];
    for (const alias of aliases) {
      names.add(alias.length === 1 ? `-${alias}` : `--${alias}`);
    }
  }
  return names;
}

/** The flags in `rawArgs` the definition does not declare, up to `--`. */
export function unknownFlags(
  rawArgs: readonly string[],
  def: ArgsDef,
): readonly string[] {
  const known = flagSpellings(def);
  const unknown: string[] = [];
  for (const token of rawArgs) {
    if (token === "--") {
      break;
    }
    if (token === "-" || !token.startsWith("-")) {
      continue;
    }
    const flag = token.split("=", 1)[0] ?? token;
    if (!known.has(flag)) {
      unknown.push(flag);
    }
  }
  return unknown;
}

/** The usage message for an unknown flag, with the nearest declared spelling. */
export function unknownFlagMessage(
  command: string,
  flag: string,
  def: ArgsDef,
): string {
  const suggestion = didYouMean(
    flag,
    [...flagSpellings(def)].filter((name) => name.startsWith("--")),
  );
  return `${command}: unknown flag '${flag}'.${suggestion === undefined ? "" : ` Did you mean ${suggestion}?`} Run permdock ${command} --help for the flags it takes.`;
}
