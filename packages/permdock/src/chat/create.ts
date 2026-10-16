import type { ApprovalErrorCode } from "../approvals/errors.ts";
import type {
  ApprovalListQuery,
  ApprovalRequest,
  ApprovalStatus,
  ApprovalStore,
} from "../approvals/types.ts";
import type {
  ApprovalRequiredDecision,
  Decision,
  DeniedDecision,
  GrantedDecision,
} from "../core/decision.ts";
import type { Operation } from "../core/operations.ts";
import type { PermDock, PermDockOptions } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { PrincipalSource } from "../core/principal-source.ts";
import type { Principal, Subject } from "../core/subject.ts";
import type { ApprovalPrompt } from "../delivery/approval-prompt.ts";
import type { ChatAuthor } from "./subject.ts";

import { isApprovalError } from "../approvals/errors.ts";
import {
  requestApproval,
  resolveApproval,
  resumeDecision,
} from "../approvals/helpers.ts";
import { withApp } from "../core/app.ts";
import { compact } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";
import { loadPermDock as loadCorePermDock } from "../core/permdock.ts";
import { nowMillis } from "../core/time.ts";
import { approvalPrompt } from "../delivery/approval-prompt.ts";
import { isChatAuthor, subjectFromChat } from "./subject.ts";

const ADAPTER = "chat";

export type ChatPermDockOptions = PermDockOptions & {
  /** Resolves chat authors through `principalByIdentity`; also the instance's principal source. */
  readonly principals: PrincipalSource;
  /** Where approval requests open and resolve. Without it an approval-required command only reports the decision. */
  readonly store?: ApprovalStore;
};

/** What a protected command's handler receives once the author is granted. */
export type ChatCommandContext<TInput, V extends PolicyVocabulary> = {
  readonly author: ChatAuthor;
  readonly input: TInput;
  /** The row the operation's `data` loaded, `undefined` without `data`. */
  readonly row: unknown;
  readonly permdock: PermDock<V>;
  readonly decision: GrantedDecision;
};

export type ChatCommandResult<T> =
  | { readonly outcome: "granted"; readonly value: T }
  | { readonly outcome: "denied"; readonly decision: DeniedDecision }
  | {
      readonly outcome: "approval-required";
      readonly decision: ApprovalRequiredDecision;
      /** The open request to deliver to approvers; `null` without an approval store. */
      readonly prompt: ApprovalPrompt | null;
    };

/** A command guarded by `protect`. Never throws for a refusal; the handler's own errors propagate. */
export type ChatCommand<TInput, T> = (
  author: ChatAuthor | null | undefined,
  input: TInput,
) => Promise<ChatCommandResult<T>>;

/** A verdict from a chat button or reaction, by approval request `id`; the token never leaves the server. */
export type ChatAction = {
  readonly approval: string;
  readonly status: "approved" | "rejected";
  readonly note?: string;
};

export type ChatActionResult =
  | {
      readonly ok: true;
      readonly id: string;
      readonly status: ApprovalStatus;
    }
  | {
      readonly ok: false;
      readonly cause: ApprovalErrorCode | "invalid-action";
    };

/**
 * The runtime-neutral chat contract: commands decided as the linked
 * principal of a verified chat author, and approval verdicts from chat
 * actions. `permdock/chat-sdk` implements it for Chat SDK bots.
 */
export type ChatPermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  /** The instance for `author`; anonymous, and so denying, when the author is unlinked. */
  readonly getPermDock: (
    author: ChatAuthor | null | undefined,
  ) => Promise<PermDock<V>>;
  /**
   * Guards `handler` with `operation`: loads the row through the
   * operation's `data`, decides as the author, and on `approval-required`
   * opens one request per author, permission and row. The handler runs only
   * when granted; an approved request runs it once.
   */
  readonly protect: <TInput, T>(
    operation: Operation<TInput>,
    handler: (context: ChatCommandContext<TInput, V>) => T | Promise<T>,
  ) => ChatCommand<TInput, T>;
  /**
   * Resolves approval request `action.approval` as `author`. The author must
   * be linked and an eligible, distinct approver; the request's requester
   * never approves their own request.
   */
  readonly resolveAction: (
    author: ChatAuthor | null | undefined,
    action: ChatAction,
  ) => Promise<ChatActionResult>;
};

function denied(
  reason: "validation" | "closure-error",
  permission: Permission,
): DeniedDecision {
  return freezeDeep({
    outcome: "denied" as const,
    denials: [{ role: null, reason, detail: { permission: permission.key } }],
    alternatives: [],
  });
}

function idOf(row: unknown): string | undefined {
  if (row === null || typeof row !== "object") {
    return undefined;
  }
  const id: unknown = Reflect.get(row, "id");
  return typeof id === "string" || typeof id === "number"
    ? String(id)
    : undefined;
}

function isLive(request: ApprovalRequest, now: number): boolean {
  return request.status !== "expired" && Date.parse(request.expiresAt) > now;
}

async function findRequest(
  store: ApprovalStore,
  id: string,
): Promise<ApprovalRequest | null> {
  if (store.getById !== undefined) {
    return store.getById(id);
  }
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- pages depend on the previous cursor
    const page = await store.list(compact<ApprovalListQuery>({ cursor }));
    const found = page.items.find((request) => request.id === id);
    if (found !== undefined) {
      return found;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return null;
}

/**
 * Creates the chat PermDock. Every command and action is decided as the
 * principal the author's chat identity links to, loaded live; an unlinked
 * author is anonymous and denied.
 */
export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  given: ChatPermDockOptions,
): ChatPermDock<V> {
  const options = withApp(policy, given);
  const { store: approvals, ...permdockOptions } = options;

  const instanceFor = (subject: Subject): Promise<PermDock<V>> =>
    loadCorePermDock(policy, subject, permdockOptions);

  const getPermDock = async (
    author: ChatAuthor | null | undefined,
  ): Promise<PermDock<V>> =>
    instanceFor(
      await subjectFromChat(author, { principals: options.principals }),
    );

  const parked = async <TInput>(
    operation: Operation<TInput>,
    decision: ApprovalRequiredDecision,
    permdock: PermDock<V>,
    row: unknown,
  ): Promise<Decision | ApprovalPrompt | null> => {
    if (approvals === undefined) {
      return null;
    }
    const resource = compact<{ readonly type: string; readonly id?: string }>({
      type: operation.permission.resource,
      id: idOf(row),
    });
    const current = await approvals.get(decision.token);
    if (current !== null && isLive(current, nowMillis())) {
      if (current.status === "pending") {
        return approvalPrompt(current, { operation });
      }
      return resumeDecision({
        decision,
        permission: operation.permission,
        subject: permdock.subject,
        store: approvals,
        resource,
        adapter: ADAPTER,
        token: decision.token,
      });
    }
    const request = await requestApproval(approvals, decision, {
      permission: operation.permission,
      resource,
      subject: permdock.subject,
      adapter: ADAPTER,
    });
    return approvalPrompt(request, { operation });
  };

  const protect = <TInput, T>(
    operation: Operation<TInput>,
    handler: (context: ChatCommandContext<TInput, V>) => T | Promise<T>,
  ): ChatCommand<TInput, T> => {
    const { permission } = operation;
    return async (author, input) => {
      const permdock = await getPermDock(author);
      let row: unknown;
      if (operation.data !== undefined) {
        try {
          row = await operation.data(input);
        } catch {
          return {
            outcome: "denied",
            decision: denied("closure-error", permission),
          };
        }
        if (
          permission.kind === "instance" &&
          (row === null || row === undefined)
        ) {
          return {
            outcome: "denied",
            decision: denied("validation", permission),
          };
        }
      }
      let decision: Decision = permdock.decide(permission, row, {
        adapter: ADAPTER,
        call: "adapter",
        operation: { name: operation.name, meta: operation.meta },
      });
      if (decision.outcome === "approval-required") {
        const resolved = await parked(operation, decision, permdock, row);
        if (resolved === null || "v" in resolved) {
          return { outcome: "approval-required", decision, prompt: resolved };
        }
        decision = resolved;
      }
      switch (decision.outcome) {
        case "granted":
          break;
        case "denied":
          return { outcome: "denied", decision };
        case "approval-required":
          return { outcome: "approval-required", decision, prompt: null };
        default: {
          const unreachable: never = decision;
          return unreachable;
        }
      }
      if (!isChatAuthor(author)) {
        return {
          outcome: "denied",
          decision: denied("validation", permission),
        };
      }
      const value = await handler({ author, input, row, permdock, decision });
      return { outcome: "granted", value };
    };
  };

  const resolveAction = async (
    author: ChatAuthor | null | undefined,
    action: ChatAction,
  ): Promise<ChatActionResult> => {
    const status: unknown = action.status;
    if (
      (status !== "approved" && status !== "rejected") ||
      typeof action.approval !== "string" ||
      action.approval === ""
    ) {
      return { ok: false, cause: "invalid-action" };
    }
    const subject = await subjectFromChat(author, {
      principals: options.principals,
    });
    if (subject.principal === null) {
      return { ok: false, cause: "approver-unauthenticated" };
    }
    if (approvals === undefined) {
      return { ok: false, cause: "approval-not-found" };
    }
    try {
      const request = await findRequest(approvals, action.approval);
      if (request === null) {
        return { ok: false, cause: "approval-not-found" };
      }
      const resolved = await resolveApproval(
        approvals,
        request.token,
        compact({ status, by: subject, note: action.note }),
        compact({
          relations: permdockOptions.relations,
          requireDistinctApprover: true,
          permdockFor: (approver: Subject) => instanceFor(approver),
        }),
      );
      return { ok: true, id: resolved.id, status: resolved.status };
    } catch (error) {
      return {
        ok: false,
        cause: isApprovalError(error) ? error.code : "approval-not-found",
      };
    }
  };

  return Object.freeze({ getPermDock, protect, resolveAction });
}
