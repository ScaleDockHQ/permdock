import type { CatalogUsage } from "../catalog/types.ts";
import type { ExitCode } from "./core/errors.ts";
import type { CollectConfig } from "./types-config.ts";

export type {
  CatalogActivation,
  CatalogApproval,
  CatalogBreakGlass,
  CatalogDelegation,
  CatalogDocument,
  CatalogGrant,
  CatalogOAuthScope,
  CatalogOperation,
  CatalogPermission,
  CatalogResource,
  CatalogRole,
  CatalogScope,
  CatalogSupportAccess,
  CatalogUsage,
} from "../catalog/types.ts";

export type DynamicUsage = {
  readonly file: string;
  readonly line: number;
  readonly call: string;
};

export type ScanResult = {
  readonly roots: readonly string[];
  readonly definitionFiles: Readonly<Record<string, string>>;
  readonly usages: Readonly<Record<string, readonly CatalogUsage[]>>;
  readonly unknown: readonly CatalogUsage[];
  readonly dynamic: readonly DynamicUsage[];
  readonly roleNames: readonly string[];
  readonly planNames: readonly string[];
  readonly allowKeys: readonly string[];
  readonly snapshots: readonly SnapshotSite[];
  /** Files under `srcPath` with a syntax error; the scan covers what parsed. */
  readonly unparsed: readonly UnparsedSource[];
};

export type UnparsedSource = {
  readonly file: string;
  readonly line: number;
  readonly message: string;
};

/**
 * `include` is `undefined` for an unscoped call and `null` when it is not a
 * literal list.
 */
export type SnapshotSite = {
  readonly file: string;
  readonly line: number;
  readonly include: readonly string[] | null | undefined;
};

export type CliIo = {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now?: () => Date;
  readonly fetch?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Styled stdout; `--no-color` turns it off. Unset is plain. */
  readonly color?: boolean;
  /** Styled stderr, decided for that stream on its own. Unset is plain. */
  readonly errColor?: boolean;
  /** A person at a terminal: commands may prompt. Unset never prompts. */
  readonly interactive?: boolean;
  /** stdout is a terminal; agent detection reads it. Unset is a pipe. */
  readonly stdoutIsTty?: boolean;
  /** stderr is a terminal: progress draws a spinner. Unset prints lines. */
  readonly stderrIsTty?: boolean;
  /** Reads all of stdin, for `--*-stdin` secrets. Unset reads nothing. */
  readonly readStdin?: () => Promise<string>;
  /** Aborted on SIGINT or SIGTERM. */
  readonly signal?: AbortSignal;
};

export type RunResult = {
  readonly code: ExitCode;
  readonly stdout: string;
  readonly stderr: string;
};

export type PermDockPluginOptions = {
  readonly collect?: CollectConfig;
  readonly onDrift?: "error" | "warn";
  /**
   * Unplugin only: compare instead of write in `buildStart`, failing the build
   * on drift (as `permdock collect --check` does). The Next plugin checks in
   * `phase-production-build` unless `PERMDOCK_COLLECT=write`.
   */
  readonly check?: boolean;
};
