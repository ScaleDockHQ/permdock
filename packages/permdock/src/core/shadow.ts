import type { Decision } from "./decision.ts";
import type { DecideOptions, PermDock } from "./permdock.ts";
import type { Permission } from "./permission-types.ts";
import type { PolicyVocabulary } from "./policy-types.ts";
import type { Subject } from "./subject.ts";
import type { PermDockWrap } from "./wrap.ts";

import { PermDockDeniedError } from "./errors.ts";
import { freezeDeep } from "./freeze.ts";
import { wrapPermDock } from "./wrap.ts";

/** The application's existing check, asked the same question PermDock is. */
export type LegacyCheck = (input: {
  readonly permission: Permission;
  readonly data: unknown;
  readonly subject: Subject;
}) => boolean;

/** One check where the legacy system and PermDock disagree. */
export type ShadowMismatch = {
  readonly permission: string;
  readonly principal: string | null;
  /** What the legacy check answered; `false` when it threw. */
  readonly legacy: boolean;
  readonly permdock: Decision["outcome"];
  /** `true` when PermDock's answer was the one returned. */
  readonly enforced: boolean;
};

export type ShadowOptions = {
  readonly legacy: LegacyCheck;
  /**
   * Permissions PermDock decides; every other check returns the legacy answer.
   * `"all"` once every mismatch is resolved; default none.
   */
  readonly enforce?: readonly Permission[] | "all";
  /** Called for each disagreement; a throw here is ignored. */
  readonly onMismatch?: (mismatch: ShadowMismatch) => void;
};

function legacyAnswer(
  legacy: LegacyCheck,
  permission: Permission,
  data: unknown,
  subject: Subject,
): boolean {
  try {
    return legacy({ permission, data, subject }) === true;
  } catch {
    // A legacy check that throws allows nothing.
    return false;
  }
}

function legacyDecision(
  allowed: boolean,
  permission: Permission,
  subject: Subject,
): Decision {
  return allowed
    ? freezeDeep({
        outcome: "granted",
        subject,
        matched: { role: "legacy", permission: permission.key },
        token: "pd1.legacy",
      })
    : freezeDeep({
        outcome: "denied",
        permission: permission.key,
        denials: [{ role: null, reason: "no-grant", detail: "legacy" }],
        alternatives: [],
      });
}

/**
 * Runs PermDock beside the application's existing checks while adopting it.
 * Each `can`, `decide`, `decideEach`, `filter` and `assert` asks both; the
 * legacy answer is returned unless the permission is in `enforce`, and every
 * disagreement reaches `onMismatch`. Promote permissions one by one as their
 * mismatches are resolved, then remove the wrap. Pass it as an adapter's `wrap`
 * option, or call it on a core instance.
 */
export function shadowMode(options: ShadowOptions): PermDockWrap {
  const enforced = (permission: Permission): boolean =>
    options.enforce === "all" ||
    (options.enforce ?? []).some((item) => item.key === permission.key);
  const report = (mismatch: ShadowMismatch): void => {
    try {
      options.onMismatch?.(mismatch);
    } catch {
      // Reporting never changes a decision.
    }
  };
  return <V extends PolicyVocabulary>(permdock: PermDock<V>): PermDock<V> =>
    wrapPermDock(permdock, (inner) => {
      const decide = (
        permission: Permission,
        data?: unknown,
        decideOptions?: DecideOptions,
      ): Decision => {
        const ours = inner.decide(permission, data, decideOptions);
        const theirs = legacyAnswer(
          options.legacy,
          permission,
          data,
          inner.subject,
        );
        const enforce = enforced(permission);
        if (theirs !== (ours.outcome === "granted")) {
          report({
            permission: permission.key,
            principal: inner.subject.principal?.id ?? null,
            legacy: theirs,
            permdock: ours.outcome,
            enforced: enforce,
          });
        }
        if (enforce || theirs === (ours.outcome === "granted")) {
          return ours;
        }
        return legacyDecision(theirs, permission, inner.subject);
      };
      const can = (
        permission: Permission,
        data?: unknown,
        decideOptions?: DecideOptions,
      ): boolean => {
        try {
          return decide(permission, data, decideOptions).outcome === "granted";
        } catch {
          return false;
        }
      };
      return {
        // SAFETY: decide implements every overload of PermDock["decide"] with the same arguments.
        decide: decide as PermDock<V>["decide"],
        // SAFETY: can implements every overload of PermDock["can"] with the same arguments.
        can: can as PermDock<V>["can"],
        decideEach: (
          permission: Permission,
          rows: readonly unknown[],
          decideOptions?: DecideOptions,
        ) => rows.map((row) => decide(permission, row, decideOptions)),
        filter: (permission, rows, decideOptions) =>
          rows.filter((row) => can(permission, row, decideOptions)),
        // SAFETY: assert implements every overload of PermDock["assert"] with the same arguments.
        assert: ((
          permission: Permission,
          data?: unknown,
          decideOptions?: DecideOptions,
        ) => {
          const decision = decide(permission, data, decideOptions);
          if (decision.outcome === "granted") {
            return decision;
          }
          if (decision.outcome === "approval-required") {
            return inner.assert(permission, data, decideOptions);
          }
          throw new PermDockDeniedError({
            decision,
            permission: permission.key,
            scope: permission.scope,
            resource: { type: permission.resource },
            subject: inner.subject,
            message: `PermDock: ${permission.key} denied`,
          });
        }) as PermDock<V>["assert"],
      };
    });
}
