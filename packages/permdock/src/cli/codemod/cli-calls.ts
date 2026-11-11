import type { GroupEntry } from "../core/manifest.ts";
import type { FlagRename } from "./cli-renames-0.5.ts";
import type { CodemodChange, CodemodFollowUp } from "./context.ts";

import { flagSpellings } from "../core/args.ts";
import { GLOBAL_FLAGS } from "../core/context.ts";
import {
  checkFlag,
  dbUrlFlags,
  dryRunFlag,
  generateFlags,
  policyFlag,
} from "../core/flags.ts";
import { ROOT } from "../core/manifest.ts";
import { flagRename, renameMessage } from "./cli-renames-0.5.ts";

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

/**
 * `permdock`, `npx permdock@0.4`, `pnpm exec permdock`: the bin name followed
 * by a space.
 */
const INVOCATION = /(?<![\w./@-])permdock(?:@[\w.^~-]+)?(?=[ \t])/gu;

/**
 * Where a shell command ends: an operator, a pipe, a redirect, a comment or a
 * closing backtick. A JSON string also ends at its closing quote. `<id>` is a
 * placeholder, not a redirect, so a redirect needs a space on both sides.
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

/**
 * The leaf path the positional tokens name, with the token after which a moved
 * subcommand goes.
 */
const REMOVED_COMMANDS = [
  {
    from: ["rls", "generate"],
    command: "rls generate",
    to: "generate --only rls",
  },
  {
    from: ["supabase", "hook", "generate"],
    command: "supabase hook generate",
    to: "generate --only supabaseHook",
  },
  {
    from: ["powersync", "generate"],
    command: "powersync generate",
    to: "generate --only powersync",
  },
  {
    from: ["scim", "generate"],
    command: "scim generate",
    to: "generate --only scim",
  },
  {
    from: ["openapi", "emit"],
    command: "openapi emit",
    to: "generate --only openapi",
  },
  { from: ["gen"], command: "gen", to: "generate" },
] as const;

function removedCommand(
  tokens: readonly Token[],
):
  | {
      readonly command: string;
      readonly start: number;
      readonly end: number;
      readonly to: string;
      readonly from: string;
    }
  | undefined {
  const words = tokens.filter((token) => !token.text.startsWith("-"));
  for (const item of REMOVED_COMMANDS) {
    const matched = item.from.every(
      (name, index) => words[index]?.text === name,
    );
    const first = words[0];
    const last = words[item.from.length - 1];
    if (matched && first !== undefined && last !== undefined) {
      return {
        command: item.command,
        start: first.start,
        end: last.end,
        to: item.to,
        from: item.from.join(" "),
      };
    }
  }
  return undefined;
}

function commandOf(tokens: readonly Token[]): string | undefined {
  let node: GroupEntry = ROOT;
  const path: string[] = [];
  for (const token of tokens) {
    if (token.text.startsWith("-")) {
      continue;
    }
    const child = node.children.find((item) => item.name === token.text);
    if (child === undefined) {
      break;
    }
    path.push(child.name);
    if (child.kind === "leaf") {
      return path.join(" ");
    }
    node = child;
  }
  return undefined;
}

const GENERATE_FLAGS: ReadonlySet<string> = new Set(
  flagSpellings({
    ...GLOBAL_FLAGS,
    ...checkFlag,
    ...dryRunFlag,
    ...policyFlag,
    ...dbUrlFlags,
    ...generateFlags,
  }),
);

function flagEdits(
  command: string,
  tokens: readonly Token[],
  notes: { readonly at: number; readonly message: string }[],
  removed: boolean,
): readonly Edit[] {
  const edits: Edit[] = [];
  for (const token of tokens) {
    if (!token.text.startsWith("--")) {
      continue;
    }
    const eq = token.text.indexOf("=");
    const name = eq === -1 ? token.text : token.text.slice(0, eq);
    const rename = flagRename(command, name);
    if (removed && !GENERATE_FLAGS.has(rename?.to ?? name)) {
      notes.push({
        at: token.start,
        message: `${command}: permdock generate takes no ${name}; move it onto the plugin in permdock.config.ts and drop it from the call.`,
      });
      continue;
    }
    if (rename === undefined) {
      continue;
    }
    const edit = flagEdit(rename, token, eq);
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
): readonly Edit[] | undefined {
  if (rename.hint !== undefined) {
    return undefined;
  }
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

/**
 * Rewrites the 0.5.0 CLI renames in shell commands: package.json scripts, CI
 * workflows, shell scripts. A rename that needs a person, such as an
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
    const removed = removedCommand(tokens);
    const command = commandOf(tokens);
    const named = removed?.command ?? command;
    if (named === undefined) {
      continue;
    }
    if (removed !== undefined) {
      edits.push({
        start: removed.start,
        end: removed.end,
        text: removed.to,
        from: removed.from,
      });
    }
    edits.push(...flagEdits(named, tokens, notes, removed !== undefined));
  }
  const changes: CodemodChange[] = [];
  let out = text;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`;
    changes.push({
      ...lineColumn(text, edit.start),
      from: edit.from,
      to: edit.text,
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
