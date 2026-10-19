import { createHash } from "node:crypto";

import type { Flags } from "./command.ts";
import type { Effect } from "./manifest.ts";

import { CliError } from "./errors.ts";

/** What an agent may not start without the person's go-ahead. */
export type ConsentReason = "rewrite" | "cloud:write" | "overwrite";

/**
 * The reasons a run needs consent: it edits files the project owns, it
 * publishes to the Cloud, or `--force` overwrites files PermDock did not
 * write. A `--dry-run` or `--check` run writes nothing and needs none.
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
 * The argv as a command line to run again: `--confirm` dropped and a
 * secret flag's value replaced by its stdin form, so the line can be shown
 * and the token does not depend on the secret.
 */
export function replayArgv(
  argv: readonly string[],
  flags: Flags,
): readonly string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    const name = token.startsWith("--")
      ? token.slice(2).split("=", 1)[0]
      : undefined;
    if (name === "confirm") {
      i += token.includes("=") ? 0 : 1;
      continue;
    }
    const flag = name === undefined ? undefined : flags[name];
    if (flag?.type === "string" && flag.secret !== undefined) {
      out.push(`--${flag.secret.stdinFlag}`);
      i += token.includes("=") ? 0 : 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

/**
 * A short token bound to what the person agrees to, the directory and the
 * command line. Hex, because a base64url token may start with `-` and parse
 * as a flag. 16 characters, as better-supabase's.
 */
export function consentToken(
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

/** The `consent_required` result an agent gets until it passes the token. */
export function consentRequired(
  command: string,
  reasons: readonly ConsentReason[],
  argv: readonly string[],
  token: string,
): CliError {
  return new CliError(
    "action",
    `permdock ${command} ${reasons.map((reason) => REASON_TEXT[reason]).join(" and ")}. Ask the person to agree, then run it again with --confirm ${token}`,
    {
      code: "consent_required",
      extensions: { reasons, token },
      next: [
        {
          when: "after the person agrees",
          command: ["permdock", ...argv.map(quote), "--confirm", token].join(
            " ",
          ),
        },
      ],
    },
  );
}
