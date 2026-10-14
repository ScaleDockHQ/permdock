import type { ApprovalStore } from "../approvals/types.ts";
import type { Decision } from "../core/decision.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { Operation } from "../core/operations.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { PolicyVocabulary } from "../core/policy-types.ts";
import type { RequestContext } from "../core/request-context.ts";
import type { Delegation } from "../core/subject.ts";
import type { Boundary } from "../core/validation.ts";
import type { PermDockWrap } from "../core/wrap.ts";
import type { OtelWrap } from "../otel/types.ts";
import type { DeniedText } from "./denied-text.ts";

/** The part of an operation a tool decision reads; an `OperationMap` entry is one. */
export type ToolBinding = Pick<Operation, "permission" | "data" | "results"> &
  Partial<Pick<Operation, "name" | "meta">>;

export type ToolMap = Readonly<Record<string, ToolBinding>>;

/**
 * The models an agent may call, by model id (`'openai/gpt-5'`), each bound to
 * the permission that grants it. An instance permission is decided on the
 * row `{ id }`.
 */
export type ModelMap = Readonly<Record<string, Permission>>;

/** The options `permdock/ai-sdk`, `permdock/openai`, `permdock/claude-agent` and `permdock/eve` share. */
export type AgentAdapterOptions<TContext, TUser = unknown> = InstanceOptions & {
  readonly subject: (context: TContext) => TUser | Promise<TUser>;
  readonly actor?: (context: TContext) => unknown;
  readonly delegation?: (
    context: TContext,
  ) => Delegation | undefined | Promise<Delegation | undefined>;
  readonly tenant?:
    | string
    | ((context: TContext) => string | undefined | Promise<string | undefined>);
  /** The tools the agent may call, by tool name: the map `defineOperations` returns. */
  readonly operations: ToolMap;
  /**
   * The model gate. Absent: the adapter never checks a model. Present: a
   * model id it does not name is denied.
   */
  readonly models?: ModelMap;
  readonly store?: ApprovalStore;
  /**
   * Tools `operations` does not name. `'deny'` (default) denies them.
   * `'allow'` leaves them to the runtime's own approval.
   */
  readonly unmapped?: "deny" | "allow";
  /**
   * Request values merged into `subject.context`, under `policy.context`.
   * Only values the server derived belong here, never model output.
   */
  readonly context?: (
    context: TContext,
  ) => RequestContext | undefined | Promise<RequestContext | undefined>;
  /** `(permdock) => withOtel(permdock, options)` from `permdock/otel`. */
  readonly otel?: OtelWrap;
  /** Wraps each instance after `otel`; build it with `wrapPermDock` to cover derived instances. */
  readonly wrap?: PermDockWrap;
  /** Replaces the denial reason or approval summary text; nothing else. */
  readonly deniedText?: DeniedText;
};

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
  readonly deniedText?: DeniedText;
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
  /** Decide with `call: 'simulate'` and skip the approval resume. */
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
