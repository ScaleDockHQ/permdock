import type { ApprovalStore } from "../approvals/types.ts";
import type { Decision } from "../core/decision.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { PolicyVocabulary } from "../core/policy-types.ts";
import type { RequestContext } from "../core/request-context.ts";
import type { Delegation } from "../core/subject.ts";
import type { Boundary } from "../core/validation.ts";
import type { OnDeniedText } from "./denied-text.ts";

export type ToolBinding = {
  readonly permission: Permission;
  readonly data?: (args: unknown) => unknown;
};

export type ToolMap = Readonly<Record<string, ToolBinding>>;

export type AgentKernelOptions<TContext, TUser = unknown> = InstanceOptions & {
  readonly subject: (context: TContext) => TUser | Promise<TUser>;
  readonly actor?: (context: TContext) => unknown;
  readonly delegation?: (
    context: TContext,
  ) => Delegation | undefined | Promise<Delegation | undefined>;
  readonly tenant?:
    | string
    | ((context: TContext) => string | undefined | Promise<string | undefined>);
  /** The tools `decideTool` and `allowedToolNames` read; adapters that bind per call omit it. */
  readonly tools?: ToolMap;
  readonly store?: ApprovalStore;
  readonly adapter: string;
  /** Reported on validation errors of the loaded row. Defaults to `'tool-args'`. */
  readonly boundary?: Boundary;
  /** Wraps every instance: `otel`, then the adapter's `wrap`. */
  readonly wrap?: (instance: PermDock) => PermDock;
  /** Replaces the text of a denied or approval-required verdict; nothing else. */
  readonly onDenied?: OnDeniedText;
  /** Request values merged into `subject.context`, under `policy.context`. */
  readonly context?: (
    context: TContext,
  ) => RequestContext | undefined | Promise<RequestContext | undefined>;
};

/** Why `check` decided nothing: the loader threw, found no row, or anything else threw. */
export type CheckFailure = "load-failed" | "no-data" | "failed";

export type CheckResult<V extends PolicyVocabulary = PolicyVocabulary> =
  | {
      readonly ok: true;
      readonly permdock: PermDock<V>;
      readonly data: unknown;
      /** The decision before an approval resume. */
      readonly raw: Decision;
      /** `raw` after the approval resume; equal to `raw` under `simulate`. */
      readonly decision: Decision;
    }
  | {
      readonly ok: false;
      readonly failure: CheckFailure;
      /** Set when the instance was built before the failure. */
      readonly permdock?: PermDock<V>;
    };

export type CheckOptions = DecideToolOptions & {
  /** Decide with `source: 'simulate'` and skip the approval resume. */
  readonly simulate?: boolean;
};

export type ToolVerdict =
  | {
      readonly outcome: "granted";
      readonly decision: Extract<Decision, { readonly outcome: "granted" }>;
      readonly permission: Permission;
      readonly data: unknown;
    }
  | {
      readonly outcome: "denied";
      readonly decision: Extract<
        Decision,
        { readonly outcome: "denied" }
      > | null;
      readonly permission: Permission | undefined;
      readonly reason: string;
    }
  | {
      readonly outcome: "approval-required";
      readonly decision: Extract<
        Decision,
        { readonly outcome: "approval-required" }
      >;
      readonly permission: Permission;
      readonly data: unknown;
      readonly token: string;
      readonly summary: string;
    };

export type DecideToolOptions = {
  readonly resumeToken?: string;
  /**
   * Treat an existing pending record as a re-check of a call that already
   * asked: deny with `approval-pending` instead of asking again. For runtimes
   * that re-run the approval hook after a human answers and run the tool on
   * anything but a denial.
   */
  readonly denyPending?: boolean;
};
