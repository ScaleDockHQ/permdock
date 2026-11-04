import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { ApprovalStore } from "../approvals/types.ts";
import type { ActionResult } from "../core/action-result.ts";
import type { Decision } from "../core/decision.ts";
import type { ProblemDetails } from "../core/errors.ts";
import type { Intent } from "../core/interfaces.ts";
import type { DecideOptions, PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type {
  ProtectAction,
  ProtectActionHooks,
  ProtectActionOptions,
  ProtectedActionHandler,
} from "./types.ts";

import { resumeDecision } from "../approvals/helpers.ts";
import { compact } from "../core/compact.ts";
import { LOAD_FAILED, NO_GRANT } from "../core/decision.ts";
import { notFoundDetails } from "../core/problem-details.ts";
import { statusProblem } from "../core/problem-types.ts";
import { resourceRef } from "../core/resource-ref.ts";
import { isThenable } from "../core/thenable.ts";
import { PermDockValidationError } from "../core/validation-error.ts";
import { decisionProblem } from "../server/problem.ts";

export type ActionDeps<V extends PolicyVocabulary> = {
  readonly policy: Policy;
  readonly getPermDock: (query?: {
    readonly tenant?: string;
    readonly intent?: Intent;
  }) => Promise<PermDock<V>>;
  readonly store: ApprovalStore | undefined;
  /** `unstable_rethrow`: lets `redirect()`, `notFound()` and bailouts through. */
  readonly rethrow: (error: unknown) => void;
};

function refused(problem: ProblemDetails): ActionResult<never> {
  return { ok: false, problem };
}

/** Issues reduced to JSON a server action can return: a symbol path is lost. */
function plainIssues(
  issues: readonly StandardSchemaV1.Issue[],
): readonly StandardSchemaV1.Issue[] {
  return issues.map((issue) =>
    compact({
      message: issue.message,
      path: issue.path?.map((segment) => {
        const key = typeof segment === "object" ? segment.key : segment;
        return typeof key === "number" ? key : String(key);
      }),
    }),
  );
}

async function parseInput<TInput>(
  schema: StandardSchemaV1<unknown, TInput>,
  value: unknown,
): Promise<StandardSchemaV1.Result<TInput>> {
  const result = schema["~standard"].validate(value);
  const settled = isThenable(result) ? await result : result;
  if (settled.issues === undefined) {
    return settled;
  }
  return { issues: plainIssues(settled.issues) };
}

function invalidInput(
  permission: Permission,
  issues: readonly StandardSchemaV1.Issue[],
): ActionResult<never> {
  return refused(
    new PermDockValidationError({
      code: "invalid-data",
      permission: permission.key,
      resource: permission.resource,
      issues,
      boundary: "action-input",
      message: `${permission.key}: ${issues.map((issue) => issue.message).join("; ")}.`,
    }).toProblemDetails(),
  );
}

/** Prefixes each issue path with the argument's position. */
function argIssues(
  index: number,
  issues: readonly StandardSchemaV1.Issue[],
): readonly StandardSchemaV1.Issue[] {
  return issues.map((issue) => ({
    message: issue.message,
    path: [index, ...(issue.path ?? [])],
  }));
}

async function parseArgs(
  schemas: readonly StandardSchemaV1[],
  values: readonly unknown[],
): Promise<
  | { readonly value: readonly unknown[] }
  | { readonly issues: readonly StandardSchemaV1.Issue[] }
> {
  const results = await Promise.all(
    schemas.map((schema, index) => parseInput(schema, values[index])),
  );
  const parsed: unknown[] = [];
  for (const [index, result] of results.entries()) {
    if (result.issues !== undefined) {
      return { issues: plainIssues(argIssues(index, result.issues)) };
    }
    parsed.push(result.value);
  }
  return { value: parsed };
}

type AnyHooks = ProtectActionHooks<
  unknown,
  PolicyVocabulary,
  readonly unknown[],
  unknown,
  unknown
>;

/**
 * `protectAction(permission, { input, args?, data?, tenant? })(handler,
 * hooks?)`: validates the arguments and the input, loads the row, decides, then
 * runs the handler. Every refusal, including a throw, is a Problem Details
 * result; nothing but Next.js interrupts leaves as an exception.
 */
export function protectActionOf<V extends PolicyVocabulary>(
  deps: ActionDeps<V>,
): ProtectAction<V> {
  // SAFETY: the implementation is untyped over TArgs; ProtectAction restores the generics for callers.
  const protect =
    (
      permission: Permission,
      options: ProtectActionOptions<unknown, unknown, readonly unknown[]>,
    ) =>
    (
      handler: ProtectedActionHandler<
        unknown,
        unknown,
        unknown,
        V,
        readonly unknown[]
      >,
      hooks?: AnyHooks,
    ) =>
    async (...call: unknown[]): Promise<ActionResult<unknown>> => {
      const schemas = options.args ?? [];
      const parsedArgs = await parseArgs(schemas, call);
      if ("issues" in parsedArgs) {
        return invalidInput(permission, parsedArgs.issues);
      }
      const args = Object.freeze(parsedArgs.value);
      const parsed = await parseInput(options.input, call[schemas.length]);
      if (parsed.issues !== undefined) {
        return invalidInput(permission, parsed.issues);
      }
      const input = parsed.value;
      const approval = approvalOf(call[schemas.length + 1]);
      let permdock: PermDock<V>;
      let data: unknown;
      try {
        permdock = await deps.getPermDock(
          compact({ tenant: options.tenant?.(input, args), intent: "write" }),
        );
      } catch (error) {
        deps.rethrow(error);
        return refused(decisionProblem(NO_GRANT, permission));
      }
      if (options.data !== undefined) {
        try {
          data = (await options.data(input, args)) ?? undefined;
        } catch (error) {
          deps.rethrow(error);
          return refused(decisionProblem(LOAD_FAILED, permission));
        }
        if (data === undefined) {
          return refused(notFoundDetails());
        }
      }
      // SAFETY: decide's generics only tie the row type to the permission; it accepts any row.
      const decide = permdock.decide as (
        next: Permission,
        row?: unknown,
        decideOptions?: DecideOptions,
      ) => Decision;
      const decision = await resumeDecision({
        decision: decide(permission, data, {
          call: "adapter",
          adapter: "next",
          trusted: true,
        }),
        permission,
        subject: permdock.subject,
        store: deps.store,
        resource: resourceRef(permission, data),
        adapter: "next",
        token: approval,
      });
      if (decision.outcome !== "granted") {
        return refused(
          decisionProblem(
            decision,
            permission,
            compact({
              disclosure:
                data === undefined
                  ? undefined
                  : deps.policy.resources.get(permission.resource)?.disclosure,
            }),
          ),
        );
      }
      const context = { permdock, decision, data, args };
      try {
        const result = await handler(input, context);
        await hooks?.after?.(decision, { ...context, result });
        const value =
          hooks?.result === undefined
            ? result
            : await hooks.result(result, context);
        return { ok: true, value };
      } catch (error) {
        deps.rethrow(error);
        return refused(
          statusProblem(500, `${permission.key}: the action failed`),
        );
      }
    };
  // SAFETY: see above.
  return protect as unknown as ProtectAction<V>;
}

function approvalOf(call: unknown): string | undefined {
  if (typeof call !== "object" || call === null || !("approval" in call)) {
    return undefined;
  }
  return typeof call.approval === "string" ? call.approval : undefined;
}
