import type { Policy } from "../index.ts";
import type { CollectOutcome } from "./collect.ts";
import type { PermDockConfig } from "./types.ts";

export type DoctorSeverity = "error" | "warning";

export type DoctorFinding = {
  readonly code: string;
  readonly severity: DoctorSeverity;
  readonly message: string;
  readonly fix: string;
};

export type DoctorSource = {
  readonly file: string;
  readonly text: string;
};

/**
 * What a check reads. `runDoctor` passes the memoised loads of one
 * `Project`; a check called without them loads the policy or runs the
 * collect itself.
 */
export type DoctorInput = {
  readonly cwd: string;
  readonly config: PermDockConfig;
  /** The configured policy, or `undefined` when unset or unloadable. */
  readonly policy?: () => Promise<Policy | undefined>;
  /** `collect --check` over the project. */
  readonly collected?: () => Promise<CollectOutcome>;
};
