import type {
  SupportAuthorize,
  SupportAuthorizeInput,
} from "better-supabase/server";

import type { PermDockOptions } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy } from "../core/policy-types.ts";
import type {
  SupportSession,
  SupportSessionDecision,
  SupportSessionRequest,
} from "../core/support-session.ts";

import { canonicalJson } from "../core/canonical-json.ts";
import { getPermDock } from "../core/permdock.ts";
import { sha256Digest } from "../core/sha256.ts";
import { decideSupportSession } from "../core/support-session.ts";
import {
  type BetterSupabaseSubjectOptions,
  subjectFromBetterSupabase,
} from "./subject.ts";

/**
 * A start `decideSupportSession` holds for approval: the session it would start
 * and the token an approval binds to.
 */
export type PendingSupportSession = {
  readonly token: string;
  readonly session: SupportSession;
};

export type SupportPolicyOptions = {
  readonly policy: Policy;
  /**
   * How the admin's verified claims map to a subject; the defaults of
   * `subjectFromBetterSupabase`.
   */
  readonly subject?: Omit<BetterSupabaseSubjectOptions, "apiKeys">;
  /**
   * Sources and sinks for the admin's instance; `settings` also supplies the
   * tenant's `supportSessions` rules.
   */
  readonly options?: Omit<
    PermDockOptions,
    "tenant" | "actor" | "delegation" | "session" | "expiresAt"
  >;
  /**
   * The session's permissions when a start asks for `readOnly: false`. Without
   * it such a start is refused; a read-only start gets every `readOnlyHint`
   * permission the admin can use.
   */
  readonly writable?: readonly Permission[];
  /**
   * Approval by someone other than the admin is required unless this is
   * `false`.
   */
  readonly approval?: boolean;
  /**
   * The approval the application recorded for `pending.token`, or `undefined`
   * while none exists. `approvedBy` is the approver's principal id and never
   * the admin's.
   */
  readonly approved?: (
    input: SupportAuthorizeInput,
    pending: PendingSupportSession,
  ) =>
    | { readonly approvedBy: string }
    | undefined
    | Promise<{ readonly approvedBy: string } | undefined>;
};

/**
 * Bound to the admin, target, tenant, reason and mode, so the same start gets
 * the same approval token each time.
 */
function requestId(input: SupportAuthorizeInput): string {
  return sha256Digest(
    canonicalJson({
      t: "better-supabase-support",
      admin: input.admin.user.id,
      target: input.targetUserId,
      tenant: input.tenant ?? null,
      reason: input.reason,
      readOnly: input.readOnly,
    }),
  );
}

/**
 * The `authorize` option of better-supabase's `supportSessions`: the admin's
 * verified claims become a PermDock subject, and the start is decided with
 * `permdock.decideSupportSession` in the requested tenant. `true` only for
 * `granted`: an `approval-required` start passes once `approved` returns a
 * distinct approver for its token. `readOnly: false` needs `writable`. A throw
 * is `false`.
 */
export function supportPolicy(options: SupportPolicyOptions): SupportAuthorize {
  return async (input) => {
    try {
      const base = await getPermDock(
        options.policy,
        subjectFromBetterSupabase(
          { kind: "user", claims: input.admin.claims },
          options.subject,
        ),
        options.options,
      );
      if (base.subject.principal?.id !== input.admin.user.id) return false;
      if (!input.readOnly && options.writable === undefined) return false;
      const permdock =
        input.tenant === undefined ? base : base.tenant(input.tenant);
      const request: SupportSessionRequest = {
        id: requestId(input),
        principal: input.targetUserId,
        reason: input.reason,
        ...(input.tenant === undefined ? {} : { tenant: input.tenant }),
        ...(input.readOnly ? {} : { permissions: options.writable }),
        ...(typeof input.metadata["reference"] === "string"
          ? { reference: input.metadata["reference"] }
          : {}),
      };
      const settings = options.options?.settings;
      const decide = (approved?: {
        readonly token: string;
        readonly approvedBy: string;
      }): Promise<SupportSessionDecision> =>
        decideSupportSession(permdock, request, {
          ...(settings === undefined ? {} : { settings }),
          ...(options.approval === false ? { approval: false } : {}),
          ...(approved === undefined
            ? {}
            : { approved: approved.token, approvedBy: approved.approvedBy }),
        });
      const decision = await decide();
      switch (decision.outcome) {
        case "granted":
          return true;
        case "denied":
          return false;
        case "approval-required": {
          const found = await options.approved?.(input, {
            token: decision.token,
            session: decision.session,
          });
          if (found === undefined) return false;
          const resumed = await decide({
            token: decision.token,
            approvedBy: found.approvedBy,
          });
          return resumed.outcome === "granted";
        }
        default: {
          const never: never = decision;
          return never;
        }
      }
    } catch {
      return false;
    }
  };
}
