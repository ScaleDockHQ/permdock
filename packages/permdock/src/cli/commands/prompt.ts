import { cancel, confirm, isCancel, multiselect } from "@clack/prompts";

import type { CommandResult } from "./context.ts";

/** What a command reports when the person at the terminal cancels a prompt. */
export const CANCELLED: CommandResult = { code: 2, output: "Cancelled." };

/** A yes or no question; `undefined` when cancelled. */
export async function ask(message: string): Promise<boolean | undefined> {
  const answer = await confirm({ message });
  if (isCancel(answer)) {
    cancel();
    return undefined;
  }
  return answer;
}

/** Pick one or more of `options`, `initial` preselected; `undefined` when cancelled. */
export async function pick(
  message: string,
  options: readonly { readonly value: string; readonly hint: string }[],
  initial: readonly string[],
): Promise<string[] | undefined> {
  const answer = await multiselect({
    message,
    options: options.map((option) => ({ ...option })),
    initialValues: [...initial],
    required: true,
  });
  if (isCancel(answer)) {
    cancel();
    return undefined;
  }
  return answer;
}
