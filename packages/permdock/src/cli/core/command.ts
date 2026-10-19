import type { CliContext } from "./context.ts";
import type { CommandResult } from "./result.ts";

/** Completion candidates for a value: ids from a catalogue, never file names. */
export type CompleteValues = () =>
  | readonly string[]
  | Promise<readonly string[]>;

type FlagBase = {
  readonly description: string;
  /** One-letter alias, written `-x`. */
  readonly alias?: string;
  /** Left out of help and completion; still parsed. */
  readonly hidden?: boolean;
};

export type BooleanFlag = FlagBase & {
  readonly type: "boolean";
  readonly default?: boolean;
  /** Help text for `--no-<name>`; set it when the default is `true`. */
  readonly negativeDescription?: string;
};

export type StringFlag = FlagBase & {
  readonly type: "string";
  readonly valueHint?: string;
  /** Every occurrence counts and values split on commas. */
  readonly repeatable?: boolean;
  /** Reads the value from stdin; the flag that names the secret's stdin form. */
  readonly secret?: { readonly stdinFlag: string; readonly env?: string };
  /** Takes a comma-separated list, as `--split helpers,seeds` does. */
  readonly list?: boolean;
  readonly complete?: CompleteValues;
};

export type EnumFlag = FlagBase & {
  readonly type: "enum";
  readonly options: readonly string[];
  readonly default?: string;
  readonly repeatable?: boolean;
};

export type Flag = BooleanFlag | StringFlag | EnumFlag;

export type Flags = Readonly<Record<string, Flag>>;

export type Positional = {
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
  /** Takes every remaining positional. Only the last one may be variadic. */
  readonly variadic?: boolean;
  readonly complete?: CompleteValues;
};

type FlagValue<F extends Flag> = F extends BooleanFlag
  ? boolean
  : F extends StringFlag
    ? F["repeatable"] extends true
      ? readonly string[]
      : string | undefined
    : F extends EnumFlag
      ? F["repeatable"] extends true
        ? readonly F["options"][number][]
        : F["default"] extends string
          ? F["options"][number]
          : F["options"][number] | undefined
      : never;

/** The values a leaf's flags parse to: booleans default to `false`, a bare string flag is `""`. */
export type FlagValues<F extends Flags> = {
  readonly [K in keyof F]: FlagValue<F[K]>;
};

export type ParsedInput<F extends Flags> = {
  readonly flags: FlagValues<F>;
  /** Positionals by name; a variadic one holds its first value. */
  readonly args: Readonly<Record<string, string | undefined>>;
  /** Every value of the variadic positional, in order. */
  readonly rest: readonly string[];
  /** Tokens after `--`. */
  readonly passthrough: readonly string[];
};

/** A command that runs: its flags and positionals, and the handler. */
export type LeafCommand<F extends Flags = Flags> = {
  readonly flags: F;
  readonly positionals?: readonly Positional[];
  readonly run: (
    ctx: CliContext,
    input: ParsedInput<F>,
  ) => CommandResult | Promise<CommandResult>;
};

/** A leaf with its flag types erased, as the manifest loads it. */
export type Leaf = {
  readonly flags: Flags;
  readonly positionals?: readonly Positional[];
  readonly run: (
    ctx: CliContext,
    input: ParsedInput<Flags>,
  ) => CommandResult | Promise<CommandResult>;
};

export function defineLeaf<const F extends Flags>(
  command: LeafCommand<F>,
): Leaf {
  // SAFETY: parseLeaf builds `input.flags` from `command.flags`, so the values match F at run time
  return command as unknown as Leaf;
}
