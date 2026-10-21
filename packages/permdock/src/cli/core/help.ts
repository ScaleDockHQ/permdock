import type { Flag, Flags, Leaf, Positional } from "./command.ts";

import { GLOBAL_FLAGS } from "./context.ts";
import {
  DOCS_BASE,
  type Entry,
  type GroupEntry,
  type LeafEntry,
  ROOT,
  SECTIONS,
  leaves,
} from "./manifest.ts";
import { type Style, createStyle } from "./style.ts";
import { cliVersion } from "./version.ts";

export const CLI_COMMANDS_SCHEMA =
  "https://permdock.com/schemas/cli-commands-v1.json" as const;

function flagLabel(name: string, flag: Flag): string {
  const alias = flag.alias === undefined ? "" : `-${flag.alias}, `;
  if (flag.type === "boolean") {
    return `${alias}--${name}`;
  }
  const hint =
    flag.type === "enum"
      ? (flag.valueHint ?? flag.options.join("|"))
      : (flag.valueHint ?? "value");
  return `${alias}--${name} <${hint}>`;
}

function flagText(flag: Flag): string {
  const text = notedText(flag);
  return flag.type === "enum" && flag.valueHint !== undefined
    ? `${text}; one of ${flag.options.join(", ")}`
    : text;
}

function notedText(flag: Flag): string {
  const notes: string[] = [];
  if (flag.type !== "boolean" && flag.repeatable === true) {
    notes.push("repeatable");
  }
  if (flag.type === "enum" && flag.default !== undefined) {
    notes.push(`default ${flag.default}`);
  }
  return notes.length === 0
    ? flag.description
    : `${flag.description} (${notes.join(", ")})`;
}

function table(
  rows: readonly (readonly [string, string])[],
  style: Style,
): string[] {
  const width = Math.max(0, ...rows.map(([left]) => left.length));
  return rows.map(
    ([left, right]) => `  ${style.paint("cyan", left.padEnd(width))}  ${right}`,
  );
}

function flagRows(flags: Flags): (readonly [string, string])[] {
  const rows: (readonly [string, string])[] = [];
  for (const [name, flag] of Object.entries(flags)) {
    if (flag.hidden === true) {
      continue;
    }
    rows.push([flagLabel(name, flag), flagText(flag)]);
    if (flag.type === "boolean" && flag.negativeDescription !== undefined) {
      rows.push([`--no-${name}`, flag.negativeDescription]);
    }
  }
  return rows;
}

function positionalUsage(positionals: readonly Positional[]): string {
  return positionals
    .map((item) => {
      const name = `${item.name}${item.variadic === true ? "..." : ""}`;
      return item.required === true ? `<${name}>` : `[${name}]`;
    })
    .join(" ");
}

function visible(entries: readonly Entry[]): readonly Entry[] {
  return entries.filter(
    (entry) => entry.kind === "group" || entry.hidden !== true,
  );
}

export function rootHelp(color: boolean): string {
  const style = createStyle(color);
  const lines = [
    `${style.paint("bold", "permdock")} ${cliVersion()}: ${ROOT.summary}`,
    "",
    `${style.paint("bold", "Usage")}  permdock <command> [flags]`,
  ];
  for (const section of SECTIONS) {
    lines.push(
      "",
      style.paint("bold", section.title),
      ...table(
        visible(section.entries).map((entry) => [entry.name, entry.summary]),
        style,
      ),
    );
  }
  lines.push(
    "",
    style.paint("bold", "Global flags"),
    ...table(
      [
        ...flagRows(GLOBAL_FLAGS),
        ["-v, --version", "Print the permdock version"],
      ],
      style,
    ),
    "",
    `Run permdock <command> --help for its flags. Docs: ${DOCS_BASE}`,
  );
  return `${lines.join("\n")}\n`;
}

export function groupHelp(
  path: readonly string[],
  group: GroupEntry,
  color: boolean,
): string {
  const style = createStyle(color);
  const name = `permdock ${path.join(" ")}`;
  const rows = visible(group.children).map(
    (child) => [`${path.join(" ")} ${child.name}`, child.summary] as const,
  );
  const lines = [
    `${style.paint("bold", name)}: ${group.summary}`,
    "",
    `${style.paint("bold", "Usage")}  ${name} <command> [flags]`,
    "",
    style.paint("bold", "Commands"),
    ...table(rows, style),
    "",
    `Run ${name} <command> --help for its flags. Docs: ${DOCS_BASE}/${group.docs}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function leafHelp(
  path: readonly string[],
  entry: LeafEntry,
  leaf: Leaf,
  color: boolean,
): string {
  const style = createStyle(color);
  const name = `permdock ${path.join(" ")}`;
  const positionals = positionalUsage(leaf.positionals ?? []);
  const lines = [
    `${style.paint("bold", name)}: ${entry.summary}`,
    "",
    `${style.paint("bold", "Usage")}  ${name}${positionals === "" ? "" : ` ${positionals}`} [flags]`,
  ];
  const args = leaf.positionals ?? [];
  if (args.length > 0) {
    lines.push(
      "",
      style.paint("bold", "Arguments"),
      ...table(
        args.map((item) => [item.name, item.description]),
        style,
      ),
    );
  }
  const rows = flagRows(leaf.flags);
  if (rows.length > 0) {
    lines.push("", style.paint("bold", "Flags"), ...table(rows, style));
  }
  lines.push(
    "",
    style.paint("bold", "Global flags"),
    `  ${Object.keys(GLOBAL_FLAGS)
      .map((flag) => `--${flag}`)
      .join(" ")}; see permdock --help`,
  );
  if (entry.examples.length > 0) {
    lines.push(
      "",
      style.paint("bold", "Examples"),
      ...entry.examples.map((example) => `  ${example}`),
    );
  }
  lines.push(
    "",
    `${style.paint("bold", "Side effects")}  ${entry.effects.length === 0 ? "none: reads only" : entry.effects.join(", ")}`,
    `${style.paint("bold", "Docs")}  ${DOCS_BASE}/${entry.docs}`,
  );
  return `${lines.join("\n")}\n`;
}

function flagJson(name: string, flag: Flag): Record<string, unknown> {
  return {
    name,
    type: flag.type,
    description: flag.description,
    ...(flag.alias === undefined ? {} : { aliases: [flag.alias] }),
    ...(flag.type === "enum" ? { choices: flag.options } : {}),
    ...(flag.type !== "string" && flag.default !== undefined
      ? { default: flag.default }
      : {}),
    ...(flag.type !== "boolean" && flag.repeatable === true
      ? { list: true }
      : {}),
    ...(flag.type === "string" && flag.valueHint !== undefined
      ? { valueHint: flag.valueHint }
      : {}),
  };
}

function flagsJson(flags: Flags): Record<string, unknown>[] {
  return Object.entries(flags)
    .filter(([, flag]) => flag.hidden !== true)
    .map(([name, flag]) => flagJson(name, flag));
}

/** One leaf as `cli-commands-v1` describes it. */
export function leafJson(
  path: readonly string[],
  entry: LeafEntry,
  leaf: Leaf,
): Record<string, unknown> {
  return {
    name: path.at(-1) ?? "",
    path: path.join(" "),
    description: entry.summary,
    docs: `${DOCS_BASE}/${entry.docs}`,
    examples: entry.examples,
    effects: entry.effects,
    config: entry.config,
    arguments: (leaf.positionals ?? []).map((item) => ({
      name: item.name,
      description: item.description,
      required: item.required === true,
      variadic: item.variadic === true,
    })),
    options: flagsJson(leaf.flags),
  };
}

function document(
  commands: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    $schema: CLI_COMMANDS_SCHEMA,
    name: "permdock",
    version: cliVersion(),
    options: flagsJson(GLOBAL_FLAGS),
    commands,
  };
}

/**
 * `<command> --help --json`: the `cli-commands-v1` document with that command
 * only.
 */
export function leafDocument(
  path: readonly string[],
  entry: LeafEntry,
  leaf: Leaf,
): Record<string, unknown> {
  return document([leafJson(path, entry, leaf)]);
}

/** `--help --json`: the commands under `path` in the `cli-commands-v1` format. */
export async function commandsJson(
  path: readonly string[],
  group: GroupEntry,
): Promise<Record<string, unknown>> {
  const listed = leaves(group, path).filter(
    (item) => item.entry.hidden !== true,
  );
  return document(
    await Promise.all(
      listed.map(async (item) =>
        leafJson(item.path, item.entry, await item.entry.load()),
      ),
    ),
  );
}
