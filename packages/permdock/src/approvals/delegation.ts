import type { Subject } from "../core/subject.ts";
import type { Instant } from "../core/time.ts";
import type {
  ApprovalDelegation,
  ApprovalDelegationSource,
  ApprovalRequest,
} from "./types.ts";

import { freezeDeep } from "../core/freeze.ts";
import { isId } from "../core/ids.ts";
import { ownRecord } from "../core/paths.ts";
import { rootMembershipId } from "../core/subject.ts";
import { dateAt } from "../core/time.ts";
import { assertApprover } from "./store.ts";

function isInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function stringList(value: unknown): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 64 ||
    !value.every(isId)
  ) {
    return undefined;
  }
  return [...new Set(value)];
}

/**
 * A frozen copy of a delegation with only the known fields, or `undefined` when
 * a known field has the wrong type, `until` is not after `from`, or the
 * delegate and the delegator are the same principal.
 */
export function parseApprovalDelegation(
  input: unknown,
): ApprovalDelegation | undefined {
  const value = ownRecord(input);
  if (value === undefined) {
    return undefined;
  }
  if (
    !isId(value["id"]) ||
    !isId(value["delegator"]) ||
    !isId(value["delegate"]) ||
    value["delegator"] === value["delegate"]
  ) {
    return undefined;
  }
  if (!isInstant(value["from"]) || !isInstant(value["until"])) {
    return undefined;
  }
  if (Date.parse(value["from"]) >= Date.parse(value["until"])) {
    return undefined;
  }
  if (value["tenant"] !== undefined && !isId(value["tenant"])) {
    return undefined;
  }
  const permissions =
    value["permissions"] === undefined
      ? undefined
      : stringList(value["permissions"]);
  if (value["permissions"] !== undefined && permissions === undefined) {
    return undefined;
  }
  const resources =
    value["resources"] === undefined
      ? undefined
      : stringList(value["resources"]);
  if (value["resources"] !== undefined && resources === undefined) {
    return undefined;
  }
  const tenant = value["tenant"];
  return freezeDeep({
    id: value["id"],
    delegator: value["delegator"],
    delegate: value["delegate"],
    ...(typeof tenant === "string" ? { tenant } : {}),
    ...(permissions === undefined ? {} : { permissions }),
    ...(resources === undefined ? {} : { resources }),
    from: value["from"],
    until: value["until"],
  });
}

/** In-process delegations. An entry that does not parse is dropped. */
export function memoryApprovalDelegationSource(
  entries: readonly unknown[],
): ApprovalDelegationSource {
  const stored = entries.flatMap((entry) => {
    const parsed = parseApprovalDelegation(entry);
    return parsed === undefined ? [] : [parsed];
  });
  return Object.freeze({
    delegationsFor(query: {
      readonly delegate: string;
      readonly tenant?: string;
      readonly at: string;
    }): readonly ApprovalDelegation[] {
      const at = Date.parse(query.at);
      if (!Number.isFinite(at)) {
        return [];
      }
      return stored.filter((entry) => {
        if (entry.delegate !== query.delegate) {
          return false;
        }
        if (query.tenant === undefined) {
          if (entry.tenant !== undefined) {
            return false;
          }
        } else if (
          entry.tenant !== undefined &&
          entry.tenant !== query.tenant
        ) {
          return false;
        }
        return Date.parse(entry.from) <= at && at < Date.parse(entry.until);
      });
    },
  });
}

function inTenant(subject: Subject, tenant: string | undefined): boolean {
  if (tenant === undefined) {
    return true;
  }
  const principal = subject.principal;
  if (principal === null) {
    return false;
  }
  if (principal.tenant === tenant) {
    return true;
  }
  return (principal.memberships ?? []).some(
    (membership) => rootMembershipId(membership) === tenant,
  );
}

function covers(
  entry: ApprovalDelegation,
  request: ApprovalRequest,
  delegate: string,
  tenant: string | undefined,
  at: number,
): boolean {
  if (entry.delegate !== delegate || entry.delegator === delegate) {
    return false;
  }
  if (Date.parse(entry.from) > at || !(at < Date.parse(entry.until))) {
    return false;
  }
  if (entry.tenant !== undefined && entry.tenant !== tenant) {
    return false;
  }
  if (
    entry.permissions !== undefined &&
    !entry.permissions.includes(request.permission)
  ) {
    return false;
  }
  return (
    entry.resources === undefined ||
    entry.resources.includes(request.resource.type)
  );
}

export type ApprovalDelegationMatch = {
  readonly delegation: ApprovalDelegation;
  readonly delegator: Subject;
  readonly relations: readonly string[];
  readonly permissions: readonly string[];
};

export type MatchDelegationOptions = {
  readonly approvalDelegations?: ApprovalDelegationSource;
  readonly subjectFor?: (
    principalId: string,
    request: ApprovalRequest,
  ) => Subject | null | undefined | Promise<Subject | null | undefined>;
  readonly now?: Instant;
  readonly requireDistinct: boolean;
  readonly factsFor: (
    subject: Subject,
  ) => Promise<{
    readonly relations: readonly string[];
    readonly permissions: readonly string[];
  }>;
};

/**
 * The first active delegation under which `delegate` may approve `request`, or
 * `undefined`. The delegator is resolved by `subjectFor` and checked with
 * `assertApprover`, so relation and permission approvers use the delegator's
 * facts. A throw, a missing option or a delegator the source does not name
 * matches nobody. The delegator's own delegations are never read.
 */
export async function matchDelegation(
  request: ApprovalRequest,
  delegate: Subject,
  options: MatchDelegationOptions,
): Promise<ApprovalDelegationMatch | undefined> {
  const principal = delegate.principal;
  const source = options.approvalDelegations;
  const subjectFor = options.subjectFor;
  if (
    principal === null ||
    principal.kind === "link" ||
    principal.kind === "feed" ||
    principal.kind === "contact" ||
    source === undefined ||
    subjectFor === undefined
  ) {
    return undefined;
  }
  const now = dateAt(options.now);
  const tenant = request.subject.principal?.tenant;
  if (!inTenant(delegate, tenant)) {
    return undefined;
  }
  let listed: readonly ApprovalDelegation[];
  try {
    listed = await source.delegationsFor({
      delegate: principal.id,
      ...(tenant === undefined ? {} : { tenant }),
      at: now.toISOString(),
    });
  } catch {
    return undefined;
  }
  if (!Array.isArray(listed)) {
    return undefined;
  }
  const at = now.getTime();
  const matches = await Promise.all(
    listed.map(async (raw): Promise<ApprovalDelegationMatch | undefined> => {
      const entry = parseApprovalDelegation(raw);
      if (
        entry === undefined ||
        !covers(entry, request, principal.id, tenant, at)
      ) {
        return undefined;
      }
      try {
        const resolved = await subjectFor(entry.delegator, request);
        if (
          resolved === null ||
          resolved === undefined ||
          resolved.principal === null ||
          resolved.principal.id !== entry.delegator ||
          resolved.principal.kind === "link" ||
          resolved.principal.kind === "feed" ||
          resolved.principal.kind === "contact"
        ) {
          return undefined;
        }
        const facts = await options.factsFor(resolved);
        assertApprover(
          request,
          resolved,
          options.requireDistinct,
          { epochMilliseconds: now.getTime() },
          facts.relations,
          facts.permissions,
        );
        return {
          delegation: entry,
          delegator: resolved,
          relations: facts.relations,
          permissions: facts.permissions,
        };
      } catch {
        return undefined;
      }
    }),
  );
  return matches.find((match) => match !== undefined);
}
