import type { CliContext } from "./context.ts";

import { CliError } from "./errors.ts";
import { readSecret } from "./io.ts";

const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)@/giu;

/** `text` with every registered secret and every URL password masked. */
export function redact(text: string, secrets: Iterable<string>): string {
  let out = text.replaceAll(URL_PASSWORD, "$1***@");
  for (const secret of secrets) {
    if (secret.length >= 4) {
      out = out.replaceAll(secret, "***");
    }
  }
  return out;
}

/**
 * The secret piped in for `--<flag>-stdin`, when it was passed, registered for
 * redaction.
 */
export async function secretInput(
  ctx: CliContext,
  input: { readonly flag: string; readonly stdin: boolean },
): Promise<string | undefined> {
  let value: string | undefined;
  if (input.stdin) {
    value = await readSecret(ctx.io.readStdin);
    if (value === undefined) {
      throw new CliError(
        "usage",
        `${ctx.command}: --${input.flag}-stdin read nothing from stdin`,
        {
          code: "missing_value",
          extensions: { flag: `--${input.flag}-stdin` },
        },
      );
    }
  }
  if (value !== undefined) {
    ctx.addSecret(value);
  }
  return value;
}
