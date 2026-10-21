/**
 * The CLI names 0.5.0 changed, in one table. `run()` turns an old spelling into
 * a `flag_renamed` or `command_moved` problem, the codemod rewrites scripts and
 * workflows from it, and the docs Naming page lists it.
 */

/** A flag a leaf no longer takes, and what replaces it. */
export type FlagRename = {
  /** Leaf paths the old flag belonged to. */
  readonly commands: readonly string[];
  readonly from: string;
  /** The new spelling; `undefined` when the flag is gone. */
  readonly to?: string;
  /** For an enum flag whose values changed too: old value to new value. */
  readonly values?: Readonly<Record<string, string>>;
  /**
   * Shown instead of a replacement when there is none, or as advice. A rename
   * with a hint and no `rewrite` needs a person: the codemod reports it instead
   * of rewriting it.
   */
  readonly hint?: string;
  /** What the codemod writes in place of the old boolean flag; `""` drops it. */
  readonly rewrite?: string;
};

/** A group that used to run a default action when called bare. */
export type CommandMove = { readonly from: string; readonly to: string };

const DB_COMMANDS = [
  "rls generate",
  "rls import",
  "rls verify",
  "supabase hook generate",
  "powersync verify",
];

export const FLAG_RENAMES: readonly FlagRename[] = [
  {
    commands: DB_COMMANDS,
    from: "--db",
    to: "--db-url-stdin",
    hint: "--db-url-stdin or DATABASE_URL",
  },
  {
    commands: DB_COMMANDS,
    from: "--db-url",
    to: "--db-url-stdin",
    hint: "--db-url-stdin or DATABASE_URL",
  },
  { commands: ["rls generate"], from: "--force", to: "--force-rls" },
  { commands: ["rls verify"], from: "--format", to: "--kind" },
  { commands: ["rls verify"], from: "--emit", to: "--kind" },
  {
    commands: ["catalog"],
    from: "--format",
    to: "--kind",
    values: { json: "catalog", schema: "json-schema", markdown: "markdown" },
  },
  { commands: ["openapi emit"], from: "--format", to: "--kind" },
  {
    commands: [
      "rls generate",
      "rls verify",
      "rls migrate",
      "powersync generate",
      "powersync verify",
      "openapi emit",
    ],
    from: "--from",
    to: "--policy",
  },
  {
    commands: ["catalog", "arazzo check"],
    from: "--from",
    to: "--permissions",
  },
  {
    commands: ["rls import", "openapi import"],
    from: "--schema",
    to: "--validator",
  },
  {
    commands: ["usage", "config", "doctor"],
    from: "--strict",
    to: "--fail-on",
    hint: "--fail-on warning",
    rewrite: "--fail-on warning",
  },
  {
    commands: ["login"],
    from: "--write",
    to: "--scope",
    hint: "--scope catalog:write",
    rewrite: "--scope catalog:write",
  },
  {
    commands: ["skills install", "skills update"],
    from: "--agent",
    to: "--for",
  },
  {
    commands: ["skills install", "skills update"],
    from: "--client",
    to: "--for",
  },
  { commands: ["init"], from: "--agent", to: "--integration" },
  { commands: ["init"], from: "--ui", to: "--integration" },
  { commands: ["init"], from: "--src", to: "--out-dir" },
  {
    commands: ["rls generate", "rls verify", "rls migrate"],
    from: "--rbac-scaffold",
    to: "--rbac",
    hint: "--rbac supabase",
    rewrite: "--rbac supabase",
  },
  {
    commands: ["rls migrate"],
    from: "--write",
    hint: "rls migrate writes by default; --dry-run prints the plan without writing",
    rewrite: "",
  },
  {
    commands: ["cloud push"],
    from: "--environment",
    to: "--project",
    hint: "--project <id>: a project id is its environment",
  },
  {
    commands: ["scan"],
    from: "--legacy",
    hint: "permdock scan lists the checks written without PermDock; drop --legacy",
    rewrite: "",
  },
];

export const COMMAND_MOVES: readonly CommandMove[] = [
  { from: "openapi", to: "openapi emit" },
  { from: "skills", to: "skills install" },
  { from: "arazzo", to: "arazzo check" },
];

/**
 * A leaf whose default flipped: a call with none of `unless` gains `add` to
 * keep its old behaviour.
 */
export type DefaultChange = {
  readonly command: string;
  readonly unless: readonly string[];
  readonly add: string;
};

export const DEFAULT_CHANGES: readonly DefaultChange[] = [
  {
    command: "rls migrate",
    unless: ["--write", "--retire-out"],
    add: "--dry-run",
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
