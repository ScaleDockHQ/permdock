import type { Flags } from "./command.ts";

import { GLOBAL_FLAGS } from "./context.ts";
import { resolve } from "./manifest.ts";

export const SHELLS = ["bash", "zsh", "fish"] as const;

export type Shell = (typeof SHELLS)[number];

function flagNames(flags: Flags): readonly string[] {
  return Object.entries(flags)
    .filter(([, flag]) => flag.hidden !== true)
    .map(([name]) => `--${name}`);
}

/** The values the flag before the cursor takes, when it is an enum. */
function enumValues(
  flags: Flags,
  previous: string | undefined,
): readonly string[] | undefined {
  if (
    previous === undefined ||
    !previous.startsWith("--") ||
    previous.includes("=")
  ) {
    return undefined;
  }
  const flag = flags[previous.slice(2)];
  return flag?.type === "enum" ? flag.options : undefined;
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
  const previous = before.at(-1);
  const resolved = resolve(before);
  let flags: Flags = GLOBAL_FLAGS;
  let names: readonly string[] = [];
  if (resolved.kind === "group") {
    if (resolved.unknown !== undefined) {
      return [];
    }
    names = resolved.entry.children
      .filter((child) => child.kind === "group" || child.hidden !== true)
      .map((child) => child.name);
  } else {
    const leaf = await resolved.entry.load();
    flags = { ...GLOBAL_FLAGS, ...leaf.flags };
  }
  const values = enumValues(flags, previous);
  if (values !== undefined) {
    return values.filter((value) => value.startsWith(partial));
  }
  if (previous?.startsWith("--") === true) {
    const flag = flags[previous.slice(2)];
    if (flag?.type === "string" && !previous.includes("=")) {
      return [];
    }
  }
  const pool = partial.startsWith("-") ? flagNames(flags) : names;
  return pool.filter((name) => name.startsWith(partial));
}

const BASH = `# permdock completion for bash: eval "$(permdock completion bash)"
_permdock() {
  local IFS=$'\\n'
  local words=("\${COMP_WORDS[@]:1:COMP_CWORD}")
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
