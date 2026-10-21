import type { Policy } from "../../index.ts";
import type { CollectOutcome } from "../collect.ts";
import type { PermDockConfig } from "../types.ts";

/** `info` is a hint: `--fail-on warning` never fails on it. */
export type DoctorSeverity = "error" | "warning" | "info";

export type DoctorFinding = {
  readonly code: string;
  readonly severity: DoctorSeverity;
  readonly message: string;
  readonly fix: string;
};

export type DoctorSource = { readonly file: string; readonly text: string };

/** The file reads a check makes, by absolute path. */
export type DoctorFiles = {
  readonly exists: (path: string) => boolean;
  /** The file's UTF-8 text; throws when it cannot be read. */
  readonly read: (path: string) => string;
  /** The entry names of a directory. */
  readonly list: (path: string) => readonly string[];
  readonly isDirectory: (path: string) => boolean;
};

/**
 * What a check reads. `runDoctor` passes the memoised loads of one `Project`; a
 * check called without them loads the policy or runs the collect itself.
 */
export type DoctorInput = {
  readonly cwd: string;
  readonly config: PermDockConfig;
  /** Defaults to `node:fs` (`nodeFiles`). */
  readonly files?: DoctorFiles;
  /** The configured policy, or `undefined` when unset or unloadable. */
  readonly policy?: () => Promise<Policy | undefined>;
  /** `collect --check` over the project. */
  readonly collected?: () => Promise<CollectOutcome>;
};
