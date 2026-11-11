import { createHash } from "node:crypto";

import type { Effect } from "./manifest.ts";

import { CliError } from "./errors.ts";

/** What an agent may not start without the person's go-ahead. */
export type ConsentReason = "rewrite" | "cloud:write" | "overwrite";

/**
 * The reasons a run needs consent: it edits files the project owns, it
 * publishes to the Cloud, or `--force` overwrites files PermDock did not write.
 * A `--dry-run` or `--check` run writes nothing and needs none.
 */
export function consentReasons(
  effects: readonly Effect[],
  flags: Readonly<Record<string, unknown>>,
): readonly ConsentReason[] {
  if (flags["dry-run"] === true || flags["check"] === true) {
    return [];
  }
  const reasons: ConsentReason[] = [];
  if (effects.includes("rewrite")) {
    reasons.push("rewrite");
  }
  if (effects.includes("cloud:write")) {
    reasons.push("cloud:write");
  }
  if (flags["force"] === true && effects.includes("files")) {
    reasons.push("overwrite");
  }
  return reasons;
}

/** A token as the shell reads it back unchanged. */
export function quote(token: string): string {
  return /^[\w@%+=:,./-]+$/u.test(token)
    ? token
    : `'${token.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * A command line as the shell splits it: whitespace between words, single and
 * double quotes, and a backslash outside single quotes. The inverse of `quote`,
 * so a `next` step's `argv` needs no shell.
 */
export function splitCommandLine(line: string): readonly string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quoted: "'" | '"' | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const char = line.charAt(i);
    if (quoted === "'") {
      if (char === "'") {
        quoted = undefined;
      } else {
        word += char;
      }
      continue;
    }
    if (char === "\\" && i + 1 < line.length) {
      i += 1;
      word += line.charAt(i);
      started = true;
      continue;
    }
    if (quoted === '"') {
      if (char === '"') {
        quoted = undefined;
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quoted = char;
      started = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
      continue;
    }
    word += char;
    started = true;
  }
  if (started) {
    words.push(word);
  }
  return words;
}

/**
 * The argv as a command line to run again, `--effects-digest` dropped. Secrets
 * only arrive through `--*-stdin` flags, so the line holds none.
 */
export function replayArgv(argv: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (token === "--") {
      out.push(...argv.slice(i));
      break;
    }
    const name = token.startsWith("--")
      ? token.slice(2).split("=", 1)[0]
      : undefined;
    if (name === "effects-digest") {
      i += token.includes("=") ? 0 : 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

/**
 * A short digest bound to what the person agrees to, the directory and the
 * command line. Hex, because a base64url value may start with `-` and parse as
 * a flag. 16 characters, as better-supabase's.
 */
export function consentDigest(
  reasons: readonly ConsentReason[],
  argv: readonly string[],
  cwd: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([reasons, cwd, ...argv]))
    .digest("hex")
    .slice(0, 16);
}

const REASON_TEXT: Readonly<Record<ConsentReason, string>> = {
  rewrite: "edits files the project owns",
  "cloud:write": "publishes to PermDock Cloud",
  overwrite: "overwrites files with --force",
};

/**
 * The `confirmation_required` error an agent gets until it passes `--yes` and
 * the digest.
 */
export function confirmationRequired(
  command: string,
  reasons: readonly ConsentReason[],
  argv: readonly string[],
  digest: string,
  stale: boolean,
): CliError {
  const effects = reasons.map(
    (reason) => `permdock ${command} ${REASON_TEXT[reason]}`,
  );
  return new CliError(
    "action",
    `${effects.join("; ")}. Ask the person to agree, then run it again with --yes --effects-digest ${digest}.${stale ? " The --effects-digest is for another command line or directory." : ""}`,
    {
      code: "confirmation_required",
      extensions: { digest, effects },
      next: [
        {
          when: "after the person agrees",
          command: [
            "permdock",
            ...argv.map(quote),
            "--yes",
            "--effects-digest",
            digest,
          ].join(" "),
        },
      ],
    },
  );
}
