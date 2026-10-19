import type { CodemodChange, CodemodFollowUp } from "./context.ts";

import { type GroupEntry, ROOT } from "../core/manifest.ts";
import {
  COMMAND_MOVES,
  DEFAULT_CHANGES,
  type FlagRename,
  flagRename,
  renameMessage,
} from "../core/renames.ts";

export type CliCallResult = {
  readonly text: string;
  readonly changes: readonly CodemodChange[];
  readonly followUps: readonly CodemodFollowUp[];
};

type Token = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

type Edit = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly from: string;
};

/** `permdock`, `npx permdock@0.4`, `pnpm exec permdock`: the bin name followed by a space. */
const INVOCATION = /(?<![\w./@-])permdock(?:@[\w.^~-]+)?(?=[ \t])/gu;

/**
 * Where a shell command ends: an operator, a pipe, a redirect, a comment or
 * a closing backtick. A JSON string also ends at its closing quote. `<id>`
 * is a placeholder, not a redirect, so a redirect needs a space on both sides.
 */
function commandEnd(text: string, from: number, json: boolean): number {
  const pattern = json
    ? /&&|\|\||[;|`)\n"]|(?<=\s)\d?[<>]{1,2}(?:&\d|\s)|\s#/u
    : /&&|\|\||[;|`)\n]|(?<=\s)\d?[<>]{1,2}(?:&\d|\s)|\s#/u;
  const match = pattern.exec(text.slice(from));
  return match === null ? text.length : from + match.index;
}

function tokensOf(text: string, start: number, end: number): readonly Token[] {
  return [...text.slice(start, end).matchAll(/\S+/gu)].map((match) => ({
    start: start + match.index,
    end: start + match.index + match[0].length,
    text: match[0],
  }));
}

function lineColumn(
  text: string,
  offset: number,
): { readonly line: number; readonly column: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - before.lastIndexOf("\n") };
}

/** The leaf path the positional tokens name, with the token after which a moved subcommand goes. */
function commandOf(tokens: readonly Token[]): {
  readonly command: string | undefined;
  readonly insertAfter?: Token;
  readonly insert?: string;
} {
  let node: GroupEntry = ROOT;
  const path: string[] = [];
  let last: Token | undefined;
  for (const token of tokens) {
    if (token.text.startsWith("-")) {
      continue;
    }
    const child = node.children.find((item) => item.name === token.text);
    if (child === undefined) {
      break;
    }
    path.push(child.name);
    last = token;
    if (child.kind === "leaf") {
      return { command: path.join(" ") };
    }
    node = child;
  }
  const move = COMMAND_MOVES.find((item) => item.from === path.join(" "));
  if (move === undefined || last === undefined) {
    return { command: undefined };
  }
  return {
    command: move.to,
    insertAfter: last,
    insert: move.to.slice(move.from.length + 1),
  };
}

function flagEdits(
  command: string,
  tokens: readonly Token[],
  notes: { readonly at: number; readonly message: string }[],
): readonly Edit[] {
  const edits: Edit[] = [];
  for (const [index, token] of tokens.entries()) {
    if (!token.text.startsWith("--")) {
      continue;
    }
    const eq = token.text.indexOf("=");
    const name = eq === -1 ? token.text : token.text.slice(0, eq);
    const rename = flagRename(command, name);
    if (rename === undefined) {
      continue;
    }
    const edit = flagEdit(rename, token, eq, tokens[index + 1]);
    if (edit === undefined) {
      notes.push({ at: token.start, message: renameMessage(command, rename) });
    } else {
      edits.push(...edit);
    }
  }
  return edits;
}

function flagEdit(
  rename: FlagRename,
  token: Token,
  eq: number,
  next: Token | undefined,
): readonly Edit[] | undefined {
  if (rename.rewrite !== undefined) {
    return eq === -1
      ? [
          {
            start: token.start,
            end: token.end,
            text: rename.rewrite,
            from: token.text,
          },
        ]
      : undefined;
  }
  if (rename.to === undefined || rename.hint !== undefined) {
    return undefined;
  }
  if (rename.values === undefined) {
    const value = eq === -1 ? "" : token.text.slice(eq);
    return [
      {
        start: token.start,
        end: token.end,
        text: `${rename.to}${value}`,
        from: token.text,
      },
    ];
  }
  if (eq !== -1) {
    const mapped = mappedValue(rename.values, token.text.slice(eq + 1));
    return mapped === undefined
      ? undefined
      : [
          {
            start: token.start,
            end: token.end,
            text: `${rename.to}=${mapped}`,
            from: token.text,
          },
        ];
  }
  const mapped =
    next === undefined ? undefined : mappedValue(rename.values, next.text);
  if (next === undefined || mapped === undefined) {
    return undefined;
  }
  return [
    { start: token.start, end: token.end, text: rename.to, from: token.text },
    { start: next.start, end: next.end, text: mapped, from: next.text },
  ];
}

function mappedValue(
  values: Readonly<Record<string, string>>,
  value: string,
): string | undefined {
  return Object.hasOwn(values, value) ? values[value] : undefined;
}

/**
 * Rewrites the 0.5.0 CLI renames in shell commands: package.json scripts,
 * CI workflows, shell scripts. A rename that needs a person, such as an
 * environment name that must become a project id, is a follow-up instead.
 */
export function rewriteCliCalls(
  text: string,
  options: { readonly json: boolean },
): CliCallResult {
  const edits: Edit[] = [];
  const notes: { at: number; message: string }[] = [];
  for (const match of text.matchAll(INVOCATION)) {
    const start = match.index + match[0].length;
    const end = commandEnd(text, start, options.json);
    const tokens = tokensOf(text, start, end);
    const { command, insertAfter, insert } = commandOf(tokens);
    if (command === undefined) {
      continue;
    }
    if (insertAfter !== undefined && insert !== undefined) {
      edits.push({
        start: insertAfter.end,
        end: insertAfter.end,
        text: ` ${insert}`,
        from: insertAfter.text,
      });
    }
    edits.push(...flagEdits(command, tokens, notes));
    for (const change of DEFAULT_CHANGES) {
      const given = new Set(tokens.map((token) => token.text));
      const last = tokens.at(-1);
      if (
        change.command === command &&
        last !== undefined &&
        !change.unless.some((flag) => given.has(flag)) &&
        !given.has(change.add)
      ) {
        edits.push({
          start: last.end,
          end: last.end,
          text: ` ${change.add}`,
          from: last.text,
        });
      }
    }
  }
  const changes: CodemodChange[] = [];
  let out = text;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    const { start, end } = edit.text === "" ? dropWithSpace(out, edit) : edit;
    out = `${out.slice(0, start)}${edit.text}${out.slice(end)}`;
    changes.push({
      ...lineColumn(text, edit.start),
      from: edit.from,
      to:
        edit.start === edit.end
          ? `${edit.from}${edit.text}`
          : edit.text === ""
            ? "(removed)"
            : edit.text,
    });
  }
  return {
    text: out,
    changes: changes.toReversed(),
    followUps: notes.map((note) => {
      const { line, column } = lineColumn(text, note.at);
      return { line, column, name: "cli", message: note.message };
    }),
  };
}

/** A dropped flag takes the space before it, so `a --legacy b` becomes `a b`. */
function dropWithSpace(
  text: string,
  edit: Edit,
): { readonly start: number; readonly end: number } {
  return text[edit.start - 1] === " "
    ? { start: edit.start - 1, end: edit.end }
    : edit;
}
