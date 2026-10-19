import { closest, distance } from "fastest-levenshtein";

import type { Flag, Flags, ParsedInput, Positional } from "./command.ts";

import { GLOBAL_FLAGS } from "./context.ts";
import { CliError } from "./errors.ts";

/** The closest name within a small edit distance, or `undefined`. */
export function didYouMean(
  given: string,
  names: readonly string[],
): string | undefined {
  if (names.length === 0) {
    return undefined;
  }
  const best = closest(given, [...names]);
  return distance(given, best) <= Math.max(1, Math.floor(given.length / 3))
    ? best
    : undefined;
}

/** A sentence suggesting `suggestion`, or nothing. */
export function suggestion(given: string, names: readonly string[]): string {
  const best = didYouMean(given, names);
  return best === undefined ? "" : ` Did you mean ${best}?`;
}

type Lookup = ReadonlyMap<
  string,
  { readonly name: string; readonly negated: boolean }
>;

/** Every spelling a flag set accepts: `--name`, `--no-name` for booleans, `-x` aliases. */
function lookupOf(flags: Flags): Lookup {
  const lookup = new Map<string, { name: string; negated: boolean }>();
  for (const [name, flag] of Object.entries(flags)) {
    lookup.set(`--${name}`, { name, negated: false });
    if (flag.type === "boolean") {
      lookup.set(`--no-${name}`, { name, negated: true });
    }
    if (flag.alias !== undefined) {
      lookup.set(`-${flag.alias}`, { name, negated: false });
    }
  }
  return lookup;
}

export function flagSpellings(flags: Flags): readonly string[] {
  return [...lookupOf(flags).keys()];
}

/** A value never starts with `-`, bar `-` itself: `--out --check` is a bare `--out`. */
function isValue(token: string | undefined): token is string {
  return token !== undefined && (token === "-" || !token.startsWith("-"));
}

function split(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function checkEnum(
  command: string,
  name: string,
  flag: Flag,
  value: string,
): void {
  if (flag.type === "enum" && !flag.options.includes(value)) {
    throw new CliError(
      "usage",
      `${command}: --${name} ${value === "" ? "needs a value" : `'${value}' is not one of ${flag.options.join(", ")}`}.${suggestion(value, flag.options)}`,
      { code: "invalid_value" },
    );
  }
}

export type RawParse = {
  /** Flag values as given; a repeatable flag collects every occurrence. */
  readonly values: ReadonlyMap<string, boolean | string | readonly string[]>;
  readonly positionals: readonly string[];
  readonly passthrough: readonly string[];
};

/**
 * Splits argv into the flags `flags` declares, positionals and the tokens
 * after `--`. An undeclared flag is a usage error naming the nearest one.
 * `--name=value`, `--name value`, `--no-name` and `-x` aliases all read.
 */
export function parseFlags(
  command: string,
  argv: readonly string[],
  flags: Flags,
): RawParse {
  const lookup = lookupOf(flags);
  const values = new Map<string, boolean | string | string[]>();
  const positionals: string[] = [];
  let passthrough: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (token === "--") {
      passthrough = argv.slice(i + 1);
      break;
    }
    if (token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const spelling = eq === -1 ? token : token.slice(0, eq);
    const found = lookup.get(spelling);
    if (found === undefined) {
      throw new CliError(
        "usage",
        `${command}: unknown flag '${spelling}'.${suggestion(
          spelling,
          [...lookup.keys(), ...lookupOf(GLOBAL_FLAGS).keys()].filter((key) =>
            key.startsWith("--"),
          ),
        )} Run permdock ${command} --help for the flags it takes.`,
        { code: "unknown_flag" },
      );
    }
    const flag = flags[found.name];
    if (flag === undefined) {
      continue;
    }
    if (flag.type === "boolean") {
      if (eq !== -1) {
        const raw = token.slice(eq + 1);
        if (raw !== "true" && raw !== "false") {
          throw new CliError(
            "usage",
            `${command}: ${spelling} takes true or false, got '${raw}'`,
            { code: "invalid_value" },
          );
        }
        values.set(found.name, (raw === "true") !== found.negated);
      } else {
        values.set(found.name, !found.negated);
      }
      continue;
    }
    let value: string;
    if (eq !== -1) {
      value = token.slice(eq + 1);
    } else if (isValue(argv[i + 1])) {
      value = argv[i + 1] ?? "";
      i += 1;
    } else {
      value = "";
    }
    if (flag.repeatable === true) {
      const items = split(value);
      for (const item of items) {
        checkEnum(command, found.name, flag, item);
      }
      const previous = values.get(found.name);
      values.set(found.name, [
        ...(Array.isArray(previous) ? previous : []),
        ...items,
      ]);
      continue;
    }
    checkEnum(command, found.name, flag, value);
    values.set(found.name, value);
  }
  return { values, positionals, passthrough };
}

/** The leaf's input: defaults applied, positionals named and counted. */
export function parseLeaf(
  command: string,
  argv: readonly string[],
  flags: Flags,
  positionals: readonly Positional[] = [],
): ParsedInput<Flags> {
  const raw = parseFlags(command, argv, flags);
  const values: Record<string, unknown> = {};
  for (const [name, flag] of Object.entries(flags)) {
    const given = raw.values.get(name);
    if (given !== undefined) {
      values[name] = given;
    } else if (flag.type === "boolean") {
      values[name] = flag.default ?? false;
    } else if (flag.repeatable === true) {
      values[name] = [];
    } else {
      values[name] = flag.type === "enum" ? flag.default : undefined;
    }
  }
  const args: Record<string, string | undefined> = {};
  const rest = [...raw.positionals];
  for (const positional of positionals) {
    args[positional.name] =
      positional.variadic === true ? rest[0] : rest.shift();
    if (positional.required === true && args[positional.name] === undefined) {
      throw new CliError(
        "action",
        `${command}: <${positional.name}> is required. Run permdock ${command} --help.`,
        {
          code: "input_required",
          extensions: { missing: [`<${positional.name}>`] },
        },
      );
    }
  }
  const variadic = positionals.at(-1)?.variadic === true;
  const extra = variadic ? [] : rest;
  if (extra.length > 0) {
    throw new CliError(
      "usage",
      `${command}: unexpected argument '${extra[0] ?? ""}'. Run permdock ${command} --help.`,
      { code: "usage" },
    );
  }
  return {
    // SAFETY: every declared flag has a value of its declared kind, set above
    flags: values as ParsedInput<Flags>["flags"],
    args,
    rest: variadic ? rest : [],
    passthrough: raw.passthrough,
  };
}
