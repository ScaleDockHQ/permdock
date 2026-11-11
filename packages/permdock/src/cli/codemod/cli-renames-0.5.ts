/**
 * Flag rows `permdock codemod 0.26` still applies when it rewrites a removed
 * generate command. The Naming page keeps the full 0.5 history.
 */

/** A flag a leaf no longer takes, and what replaces it. */
export type FlagRename = {
  /** Leaf paths the old flag belonged to. */
  readonly commands: readonly string[];
  readonly from: string;
  /** The new spelling. */
  readonly to: string;
  /** Advice for a rename that needs a person: reported, not rewritten. */
  readonly hint?: string;
};

const FLAG_RENAMES: readonly FlagRename[] = [
  {
    commands: ["rls generate", "supabase hook generate"],
    from: "--db",
    to: "--db-url-stdin",
    hint: "--db-url-stdin or DATABASE_URL",
  },
  {
    commands: ["rls generate", "supabase hook generate"],
    from: "--db-url",
    to: "--db-url-stdin",
    hint: "--db-url-stdin or DATABASE_URL",
  },
  {
    commands: ["rls generate", "powersync generate", "openapi emit"],
    from: "--from",
    to: "--policy",
  },
];

/** The rename that matches `flag` (as typed, before any `=`) on `command`. */
export function flagRename(
  command: string,
  flag: string,
): FlagRename | undefined {
  return FLAG_RENAMES.find(
    (rename) => rename.from === flag && rename.commands.includes(command),
  );
}

export function renameMessage(command: string, rename: FlagRename): string {
  return `${command}: ${rename.from} is ${rename.hint ?? rename.to} since 0.5.0.`;
}
