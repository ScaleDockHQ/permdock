import type { Decision } from "../core/decision.ts";
import type { StoreRequest } from "./request.ts";
import type { ApprovalState } from "./types.ts";

/** Ceiling for the approval poll backoff after a failed status request. */
const APPROVAL_BACKOFF_CAP_MS = 60_000;
/** Consecutive failed status requests after which a token is no longer polled. */
const APPROVAL_MAX_FAILURES = 5;

const TERMINAL: ReadonlySet<ApprovalState> = new Set([
  "approved",
  "rejected",
  "expired",
]);

type ApprovalOptions = {
  /** The approvals base URL; status polls go to `<approvals>/<token>`. */
  readonly approvals: string | undefined;
  readonly endpoint: string | undefined;
  /** Milliseconds between status polls. */
  readonly interval: number;
  readonly server: boolean;
  readonly request: StoreRequest;
  readonly emit: () => void;
  readonly disposed: () => boolean;
  /** Whether anything subscribes to the store; polls only run while it does. */
  readonly listening: () => boolean;
  readonly simulated: () => boolean;
};

export type Approvals = {
  /** While something subscribes, an `approval-required` decision is polled. */
  readonly state: (decision: Decision) => ApprovalState;
  readonly request: (decision: Decision, note?: string) => Promise<void>;
  /** Drops every token: a poll answer for the previous user is ignored. */
  forget(): void;
  stop(): void;
  /** Polls the watched tokens again after the first subscriber returns. */
  resume(): void;
};

export function createApprovals(options: ApprovalOptions): Approvals {
  const { interval } = options;
  const approvals = new Map<string, ApprovalState>();
  const polls = new Map<string, ReturnType<typeof setTimeout>>();
  // Tokens a render asked about that have not reached a terminal state.
  const watched = new Set<string>();
  // Consecutive failed status requests per token; a success resets it.
  const failures = new Map<string, number>();
  let epoch = 0;

  const stop = (): void => {
    for (const timer of polls.values()) {
      clearTimeout(timer);
    }
    polls.clear();
  };

  // Resolves to the next state, `"refused"` for an answer that will not change
  // by asking again (a 4xx other than 404), or `undefined` for a failure.
  const poll = async (
    href: string,
  ): Promise<ApprovalState | "refused" | undefined> => {
    try {
      const response = await options.request(href);
      if (response.status === 404) {
        return "expired";
      }
      if (response.status >= 400 && response.status < 500) {
        return "refused";
      }
      if (!response.ok) {
        return undefined;
      }
      // SAFETY: status is only compared with the four literals; a null body throws into the catch.
      const body = (await response.json()) as { readonly status?: unknown };
      return body.status === "pending" ||
        body.status === "approved" ||
        body.status === "rejected" ||
        body.status === "expired"
        ? body.status
        : undefined;
    } catch {
      return undefined;
    }
  };

  const schedule = (token: string): void => {
    if (
      options.disposed() ||
      options.server ||
      options.approvals === undefined ||
      polls.has(token) ||
      !options.listening()
    ) {
      return;
    }
    const started = epoch;
    const href = `${options.approvals.replace(/\/+$/u, "")}/${encodeURIComponent(token)}`;
    const failed = failures.get(token) ?? 0;
    const delay = Math.min(
      interval * 2 ** failed,
      Math.max(interval, APPROVAL_BACKOFF_CAP_MS),
    );
    polls.set(
      token,
      setTimeout(() => {
        void poll(href).then((answer) => {
          if (started !== epoch || options.disposed()) {
            return;
          }
          polls.delete(token);
          const next = answer === "refused" ? undefined : answer;
          if (next !== undefined && approvals.get(token) !== next) {
            approvals.set(token, next);
            options.emit();
          }
          const count =
            answer === undefined ? (failures.get(token) ?? 0) + 1 : 0;
          if (count === 0) {
            failures.delete(token);
          } else {
            failures.set(token, count);
          }
          if (
            answer === "refused" ||
            count >= APPROVAL_MAX_FAILURES ||
            TERMINAL.has(approvals.get(token) ?? "required")
          ) {
            watched.delete(token);
            failures.delete(token);
          } else {
            schedule(token);
          }
        });
      }, delay),
    );
  };

  return {
    state(decision): ApprovalState {
      if (decision.outcome !== "approval-required") {
        return "not-needed";
      }
      const current = approvals.get(decision.token) ?? "required";
      if (TERMINAL.has(current)) {
        watched.delete(decision.token);
      } else {
        watched.add(decision.token);
        schedule(decision.token);
      }
      return current;
    },
    async request(decision, note): Promise<void> {
      if (decision.outcome !== "approval-required" || options.simulated()) {
        return;
      }
      const href = options.approvals ?? options.endpoint;
      if (href === undefined) {
        return;
      }
      const response = await options.request(href, {
        permission: decision.grant.permission,
        token: decision.token,
        note,
      });
      if (
        response.ok &&
        !TERMINAL.has(approvals.get(decision.token) ?? "required")
      ) {
        approvals.set(decision.token, "pending");
        options.emit();
      }
    },
    forget(): void {
      epoch += 1;
      stop();
      approvals.clear();
      watched.clear();
      failures.clear();
    },
    stop,
    resume(): void {
      for (const token of watched) {
        schedule(token);
      }
    },
  };
}
