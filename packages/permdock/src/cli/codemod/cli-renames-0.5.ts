/**
 * Flag rows `permdock codemod 0.26` still applies when it rewrites a removed
 * generate command. The Naming page keeps the full 0.5 history.
 */

/** A flag a leaf no longer takes, and what replaces it. */
export type FlagRename = {
  /** Leaf paths the old flag belonged to. */
  readonly commands: readonly string[];
  readonly from: string;
  /** The new spelling; `undefined` when the flag is gone. */
  readonly to?: string;
  /**
   * Shown instead of a replacement when there is none, or as advice. A rename
   * with a hint and no `rewrite` needs a person: the codemod reports it instead
   * of rewriting it.
   */
  readonly hint?: string;
  /** What the codemod writes in place of the old boolean flag; `""` drops it. */
  readonly rewrite?: string;
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
  { commands: ["rls generate"], from: "--force", to: "--force-rls" },
  { commands: ["openapi emit"], from: "--format", to: "--kind" },
  {
    commands: ["rls generate", "powersync generate", "openapi emit"],
    from: "--from",
    to: "--policy",
  },
  {
    commands: ["rls generate"],
    from: "--rbac-scaffold",
    to: "--rbac",
    hint: "--rbac supabase",
    rewrite: "--rbac supabase",
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
  const replacement = rename.hint ?? rename.to;
  return replacement === undefined
    ? `${command}: ${rename.from} was removed in 0.5.0.`
    : rename.to === undefined
      ? `${command}: ${rename.from} was removed in 0.5.0: ${replacement}.`
      : `${command}: ${rename.from} is ${replacement} since 0.5.0.`;
}
