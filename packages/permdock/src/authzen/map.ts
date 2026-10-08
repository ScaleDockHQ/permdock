import type { Decision, DenialReason } from "../core/decision.ts";
import type { Permission } from "../core/permissions.ts";
import type { Actor, Delegation } from "../core/subject.ts";
import type { PermissionLookup } from "../server/evaluation-items.ts";

import { compact } from "../core/compact.ts";
import { itemResourceData } from "../server/evaluation-items.ts";

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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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

export function resourceIdOf(item: AuthzenItem): string | undefined {
  const id = item.resource?.id;
  if (typeof id === "string" || typeof id === "number") {
    return String(id);
  }
  return undefined;
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

export function actorOf(item: AuthzenItem): Actor | undefined {
  const context = isRecord(item.context) ? item.context : {};
  const fromSubject = isRecord(item.subject?.properties)
    ? item.subject.properties["actor"]
    : undefined;
  const raw = context["actor"] ?? fromSubject;
  if (!isRecord(raw) || typeof raw["id"] !== "string") {
    return undefined;
  }
  const kind = typeof raw["kind"] === "string" ? raw["kind"] : "oauth-client";
  return { id: raw["id"], kind };
}

export function delegationOf(item: AuthzenItem): Delegation | undefined {
  const context = isRecord(item.context) ? item.context : {};
  const fromSubject = isRecord(item.subject?.properties)
    ? item.subject.properties["delegation"]
    : undefined;
  const raw = context["delegation"] ?? fromSubject;
  if (!isRecord(raw)) {
    return undefined;
  }
  const scopes = raw["scopes"];
  const authorizationDetails = raw["authorizationDetails"];
  return compact<Delegation>({
    scopes: Array.isArray(scopes)
      ? scopes.filter((scope) => typeof scope === "string")
      : undefined,
    authorizationDetails: Array.isArray(authorizationDetails)
      ? authorizationDetails
      : undefined,
  });
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
export type EvaluationContext = { readonly permdock: PermDockContext };

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

function evaluationContext(decision: Decision): EvaluationContext {
  return { permdock: permdockContext(decision) };
}

export function evaluationRow(decision: Decision): {
  readonly decision: boolean;
  readonly context: EvaluationContext;
} {
  return {
    decision: decision.outcome === "granted",
    context: evaluationContext(decision),
  };
}

export function pathnameOf(request: Request): string {
  return new URL(request.url).pathname;
}

export function endsWithPath(pathname: string, suffix: string): boolean {
  return pathname === suffix || pathname.endsWith(suffix);
}

export function mergeItem(shared: AuthzenItem, item: unknown): AuthzenItem {
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

export function pageOf(body: Record<string, unknown>): {
  readonly offset: number;
  readonly size: number;
} {
  const page = isRecord(body["page"]) ? body["page"] : {};
  const raw =
    typeof page["token"] === "string"
      ? page["token"]
      : typeof page["next_token"] === "string"
        ? page["next_token"]
        : "0";
  const parsed = Math.trunc(Number(raw));
  const sizeRaw = page["limit"] ?? page["size"];
  const size =
    typeof sizeRaw === "number" && sizeRaw > 0 ? Math.min(sizeRaw, 200) : 50;
  return {
    offset: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
    size,
  };
}

export function paged<T>(
  items: readonly T[],
  offset: number,
  size: number,
): {
  readonly results: readonly T[];
  readonly page: {
    readonly next_token: string;
    readonly count: number;
    readonly total: number;
  };
} {
  const slice = items.slice(offset, offset + size);
  const next = offset + slice.length;
  return {
    results: slice,
    page: {
      next_token: next < items.length ? String(next) : "",
      count: slice.length,
      total: items.length,
    },
  };
}
