import type { CompleteValues, Flags, Leaf } from "./command.ts";

import { GLOBAL_FLAGS } from "./context.ts";
import { resolve } from "./manifest.ts";

export const SHELLS = ["bash", "zsh", "fish"] as const;

export type Shell = (typeof SHELLS)[number];

function flagNames(flags: Flags): readonly string[] {
  return Object.entries(flags)
    .filter(([, flag]) => flag.hidden !== true)
    .map(([name]) => `--${name}`);
}

/** The flag `token` names when it waits for a separate value, as `--only` does and `--only=x` does not. */
function valueFlag(flags: Flags, token: string | undefined) {
  if (token === undefined || !token.startsWith("--") || token.includes("=")) {
    return undefined;
  }
  const flag = flags[token.slice(2)];
  return flag === undefined || flag.type === "boolean" ? undefined : flag;
}

/** The positional the next bare word fills, after the words already typed past the leaf's path. */
function positionalAt(leaf: Leaf, typed: readonly string[]) {
  let index = 0;
  for (let i = 0; i < typed.length; i += 1) {
    const token = typed[i] ?? "";
    if (token === "--") {
      return undefined;
    }
    if (token.startsWith("-")) {
      if (valueFlag({ ...GLOBAL_FLAGS, ...leaf.flags }, token) !== undefined) {
        i += 1;
      }
      continue;
    }
    index += 1;
  }
  const positionals = leaf.positionals ?? [];
  const last = positionals.at(-1);
  return positionals[index] ?? (last?.variadic === true ? last : undefined);
}

/** Values from `complete`, matched against what follows the last comma when the value is a list. */
async function valuesFor(
  complete: CompleteValues,
  partial: string,
  list: boolean,
): Promise<readonly string[]> {
  const cut = list ? partial.lastIndexOf(",") + 1 : 0;
  const head = partial.slice(0, cut);
  const taken = head.split(",");
  const tail = partial.slice(cut);
  return (await complete())
    .filter((value) => value.startsWith(tail) && !taken.includes(value))
    .map((value) => head + value);
}

/**
 * Candidates for the last word of `words`, the tokens typed after
 * `permdock`. An empty list leaves the shell to complete file names.
 */
export async function candidates(
  words: readonly string[],
): Promise<readonly string[]> {
  const partial = words.at(-1) ?? "";
  const before = words.slice(0, -1);
  const resolved = resolve(before);
  if (resolved.kind === "group") {
    if (resolved.unknown !== undefined) {
      return [];
    }
    const pool = partial.startsWith("-")
      ? flagNames(GLOBAL_FLAGS)
      : resolved.entry.children
          .filter((child) => child.kind === "group" || child.hidden !== true)
          .map((child) => child.name);
    return pool.filter((name) => name.startsWith(partial));
  }
  const leaf = await resolved.entry.load();
  const flags: Flags = { ...GLOBAL_FLAGS, ...leaf.flags };
  const flag = valueFlag(flags, before.at(-1));
  if (flag?.type === "enum") {
    return valuesFor(() => flag.options, partial, flag.repeatable === true);
  }
  if (flag?.type === "string") {
    return flag.complete === undefined
      ? []
      : valuesFor(
          flag.complete,
          partial,
          flag.repeatable === true || flag.list === true,
        );
  }
  if (partial.startsWith("-")) {
    return flagNames(flags).filter((name) => name.startsWith(partial));
  }
  const positional = positionalAt(leaf, resolved.rest);
  return positional?.complete === undefined
    ? []
    : valuesFor(positional.complete, partial, false);
}

const BASH = `# permdock completion for bash: eval "$(permdock completion bash)"
_permdock() {
  local -a words=("\${COMP_WORDS[@]:1:COMP_CWORD}")
  local IFS=$'\\n'
  COMPREPLY=($(permdock __complete -- "\${words[@]}" 2>/dev/null))
  if [ \${#COMPREPLY[@]} -eq 0 ]; then
    COMPREPLY=($(compgen -f -- "\${COMP_WORDS[COMP_CWORD]}"))
  fi
}
complete -o filenames -F _permdock permdock
`;

const ZSH = `#compdef permdock
# permdock completion for zsh: permdock completion zsh > "\${fpath[1]}/_permdock"
_permdock() {
  local -a reply
  reply=("\${(@f)$(permdock __complete -- "\${words[@]:1:CURRENT-1}" 2>/dev/null)}")
  if (( \${#reply[@]} == 0 )) || [[ -z "\${reply[1]}" ]]; then
    _files
  else
    compadd -a reply
  fi
}
compdef _permdock permdock
`;

const FISH = `# permdock completion for fish: permdock completion fish > ~/.config/fish/completions/permdock.fish
function __permdock_complete
  set -l words (commandline -opc)[2..-1] (commandline -ct)
  permdock __complete -- $words 2>/dev/null
end
complete -c permdock -f -a '(__permdock_complete)'
`;

export function completionScript(shell: Shell): string {
  switch (shell) {
    case "bash":
      return BASH;
    case "zsh":
      return ZSH;
    case "fish":
      return FISH;
    default: {
      const unknown: never = shell;
      return unknown;
    }
  }
}
