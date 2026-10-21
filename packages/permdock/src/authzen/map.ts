import type { Decision, DenialReason } from "../core/decision.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Actor, Delegation } from "../core/subject.ts";

import { compact, isRecord } from "../core/compact.ts";
import { fromWireDelegation } from "../core/wire-delegation.ts";
import {
  type PermissionLookup,
  itemResourceData,
  wireResourceId,
} from "../server/evaluation-items.ts";
import {
  type EvaluationReasons,
  evaluationReasons,
} from "../server/evaluations.ts";

export type AuthzenEntity = {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly properties?: unknown;
  readonly name?: unknown;
};

export type AuthzenItem = {
  readonly subject?: AuthzenEntity;
  readonly action?: AuthzenEntity;
  readonly resource?: AuthzenEntity;
  readonly context?: unknown;
};

export const UNKNOWN: Decision = {
  outcome: "denied",
  denials: [{ role: null, reason: "no-grant", detail: "unknown-permission" }],
  alternatives: [],
};

export const UNAVAILABLE: Decision = {
  outcome: "denied",
  denials: [{ role: null, reason: "no-grant", detail: "resource-unavailable" }],
  alternatives: [],
};

function actionNameOf(item: AuthzenItem): string | undefined {
  if (typeof item.action?.name === "string") {
    return item.action.name;
  }
  if (!isRecord(item.action?.properties)) {
    return undefined;
  }
  const scope = item.action.properties["scope"];
  return typeof scope === "string" ? scope : undefined;
}

export function permissionOf(
  lookup: PermissionLookup,
  item: AuthzenItem,
): Permission | undefined {
  return lookup(actionNameOf(item), item.resource);
}

export function resourceData(item: AuthzenItem): unknown {
  return itemResourceData(item.resource);
}

/** The row id an item names; `undefined` for none and for the collection sentinel `id: "*"`. */
export function resourceIdOf(item: AuthzenItem): string | undefined {
  return wireResourceId(item.resource?.id);
}

export function userFromEntity(entity: AuthzenEntity | undefined): unknown {
  if (entity === undefined) {
    return null;
  }
  const result: Record<string, unknown> = {};
  if (typeof entity.id === "string" || typeof entity.id === "number") {
    result["id"] = String(entity.id);
  }
  if (isRecord(entity.properties)) {
    for (const [key, value] of Object.entries(entity.properties)) {
      if (key === "actor" || key === "delegation") {
        continue;
      }
      result[key] = value;
    }
  }
  return Object.keys(result).length === 0 ? null : result;
}

function contextOrSubject(item: AuthzenItem, name: string): unknown {
  const fromContext = isRecord(item.context) ? item.context[name] : undefined;
  return (
    fromContext ??
    (isRecord(item.subject?.properties)
      ? item.subject.properties[name]
      : undefined)
  );
}

export function actorOf(item: AuthzenItem): Actor | undefined {
  const raw = contextOrSubject(item, "actor");
  if (!isRecord(raw) || typeof raw["id"] !== "string") {
    return undefined;
  }
  const kind = typeof raw["kind"] === "string" ? raw["kind"] : "oauth-client";
  return { id: raw["id"], kind };
}

export function delegationOf(item: AuthzenItem): Delegation | undefined {
  return fromWireDelegation(contextOrSubject(item, "delegation"));
}

export function tenantOf(item: AuthzenItem): string | undefined {
  if (!isRecord(item.context) || typeof item.context["tenant"] !== "string") {
    return undefined;
  }
  return item.context["tenant"];
}

/**
 * What another PEP learns from an evaluation: the outcome, the denial reasons
 * and the approval token. Grants, conditions and `alternatives` stay inside;
 * `search/action` is the only place a PEP asks what else is permitted.
 */
export type PermDockContext = {
  readonly outcome: Decision["outcome"];
  readonly denials?: readonly {
    readonly role: string | null;
    readonly reason: DenialReason;
  }[];
  readonly token?: string;
  readonly reason?: "unknown-permission";
};

/** Only the outcome, denial reasons and token leave the PDP; `alternatives` are `search/action`. */
export type EvaluationContext = EvaluationReasons & {
  readonly permdock: PermDockContext;
};

function permdockContext(decision: Decision): PermDockContext {
  switch (decision.outcome) {
    case "granted":
      return { outcome: "granted" };
    case "denied": {
      const unknown = decision.denials.some(
        (denial) => denial.detail === "unknown-permission",
      );
      return compact<PermDockContext>({
        outcome: "denied",
        denials: decision.denials.map((denial) => ({
          role: denial.role,
          reason: denial.reason,
        })),
        reason: unknown ? "unknown-permission" : undefined,
      });
    }
    case "approval-required":
      return { outcome: "approval-required", token: decision.token };
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

export function evaluationRow(
  decision: Decision,
  permission: string,
): {
  readonly decision: boolean;
  readonly context: EvaluationContext;
} {
  return {
    decision: decision.outcome === "granted",
    context: {
      permdock: permdockContext(decision),
      ...evaluationReasons(decision, permission),
    },
  };
}

export function pathnameOf(request: Request): string {
  return new URL(request.url).pathname;
}

export function endsWithPath(pathname: string, suffix: string): boolean {
  return pathname === suffix || pathname.endsWith(suffix);
}

/**
 * One item of an `evaluations` batch with the request's top-level `subject`,
 * `action`, `resource` and `context` filled in where the item omits them.
 */
export function mergeEvaluationItem(
  shared: AuthzenItem,
  item: unknown,
): AuthzenItem {
  if (!isRecord(item)) {
    return shared;
  }
  return compact<AuthzenItem>({
    subject: isRecord(item["subject"]) ? item["subject"] : shared.subject,
    action: isRecord(item["action"]) ? item["action"] : shared.action,
    resource: isRecord(item["resource"]) ? item["resource"] : shared.resource,
    context: item["context"] ?? shared.context,
  });
}
