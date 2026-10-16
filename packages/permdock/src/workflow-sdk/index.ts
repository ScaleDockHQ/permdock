import type { Decision, Denial } from "../core/decision.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type {
  AutomationOptions,
  StartAutomationResult,
  WorkflowPermDock,
} from "../workflow/create.ts";
import type {
  ApprovalWaiter,
  ApprovalWaitOptions,
} from "../workflow/waiter.ts";

import { freezeDeep } from "../core/freeze.ts";

/** The part of a Workflow SDK `Hook` the waiter reads: awaiting it suspends the run. */
export type WorkflowSdkHook = {
  readonly then: PromiseLike<unknown>["then"];
  dispose(): void;
};

/** `createHook` from `workflow`; valid only inside a `"use workflow"` function. */
export type WorkflowSdkCreateHook = (options: {
  readonly token: string;
}) => WorkflowSdkHook;

/** `resumeHook` from `workflow/api`. */
export type WorkflowSdkResumeHook = (
  token: string,
  payload: unknown,
) => Promise<unknown>;

/** `sleep` from `workflow`; valid only inside a `"use workflow"` function. */
export type WorkflowSdkSleep = (until: Date) => PromiseLike<unknown>;

/** `start` from `workflow/api`, with the workflow function and its arguments. */
export type WorkflowSdkStart<TArgs extends unknown[], TRun> = (
  workflow: (ticket: string, ...args: TArgs) => Promise<unknown>,
  args: [string, ...TArgs],
) => Promise<TRun>;

export type WorkflowSdkWaiterOptions = {
  readonly createHook: WorkflowSdkCreateHook;
  readonly resumeHook: WorkflowSdkResumeHook;
  /** With `sleep`, a wait ends at the request's `expiresAt`; without it, only a wake ends it. */
  readonly sleep?: WorkflowSdkSleep;
};

const HOOK_PREFIX = "permdock:approval:";

/** The Workflow SDK hook token a run parks on while approval `token` is pending. */
export function approvalHookToken(token: string): string {
  return `${HOOK_PREFIX}${token}`;
}

/**
 * An `ApprovalWaiter` over Workflow SDK hooks. `wait` parks the run on a hook
 * and must run inside the workflow function; `wake` resumes it from an
 * approval handler. The hook carries no verdict: the run decides again from
 * the approval store after it wakes.
 */
export function workflowSdkWaiter(
  options: WorkflowSdkWaiterOptions,
): ApprovalWaiter {
  const { createHook, resumeHook, sleep } = options;
  return Object.freeze({
    async wait(token: string, waitOptions: ApprovalWaitOptions = {}) {
      const hook = createHook({ token: approvalHookToken(token) });
      try {
        const expiresAt = waitOptions.expiresAt?.epochMilliseconds;
        if (sleep === undefined || expiresAt === undefined) {
          await hook;
          return;
        }
        await Promise.race([hook, sleep(new Date(expiresAt))]);
      } finally {
        hook.dispose();
      }
    },
    async wake(token: string) {
      try {
        await resumeHook(approvalHookToken(token), { token });
      } catch {
        // A run that already ended or never parked has nothing to wake.
      }
    },
  });
}

export type StartAutomationRunResult<TRun> =
  | (Extract<StartAutomationResult, { readonly outcome: "started" }> & {
      readonly workflowRun: TRun;
    })
  | Extract<StartAutomationResult, { readonly outcome: "denied" }>;

/**
 * Starts automation `id` and, when PermDock grants it, the Workflow SDK run
 * that executes it, with the run ticket as the workflow's first argument. A
 * denied start starts nothing.
 */
export async function startAutomation<TArgs extends unknown[], TRun>(
  workflow: Pick<WorkflowPermDock, "start">,
  start: WorkflowSdkStart<TArgs, TRun>,
  run: (ticket: string, ...args: TArgs) => Promise<unknown>,
  id: string,
  args: TArgs,
  options?: AutomationOptions,
): Promise<StartAutomationRunResult<TRun>> {
  const started = await workflow.start(id, options);
  if (started.outcome !== "started") {
    return started;
  }
  const workflowRun = await start(run, [started.ticket, ...args]);
  return Object.freeze({ ...started, workflowRun });
}

function hookDenied(): Decision {
  const denial: Denial = {
    role: null,
    reason: "validation",
    detail: { cause: "hook-unavailable" },
  };
  return freezeDeep({
    outcome: "denied" as const,
    denials: [denial],
    alternatives: [],
  });
}

/**
 * Resumes hook `token` with `payload` only when `caller` is granted
 * `permission` on `row`. A token alone never resumes a run. A hook that is
 * gone or a resume that throws denies with `validation`.
 */
export async function authorizeHook(
  resumeHook: WorkflowSdkResumeHook,
  caller: PermDock,
  permission: Permission,
  row: unknown,
  token: string,
  payload: unknown,
): Promise<Decision> {
  const decision = caller.decide(permission, row);
  if (decision.outcome !== "granted") {
    return decision;
  }
  try {
    await resumeHook(token, payload);
  } catch {
    return hookDenied();
  }
  return decision;
}
