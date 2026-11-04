import type { Membership } from "./subject.ts";

import { compact, isRecord } from "./compact.ts";

function asStrings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export type ReadMemberships = {
  readonly memberships: readonly Membership[];
  /** Indexes of the entries that could not be read and were dropped. */
  readonly dropped: readonly number[];
};

/**
 * Reads the `memberships` claim; an entry it cannot read is dropped and its
 * index reported.
 */
export function readMemberships(value: unknown): ReadMemberships {
  if (!Array.isArray(value)) {
    return { memberships: [], dropped: [] };
  }
  const out: Membership[] = [];
  const dropped: number[] = [];
  for (const [index, item] of value.entries()) {
    const membership = asMembership(item);
    if (membership === undefined) {
      dropped.push(index);
    } else {
      out.push(membership);
    }
  }
  return { memberships: out, dropped };
}

function asMembership(item: unknown): Membership | undefined {
  if (!isRecord(item) || !Array.isArray(item["roles"])) {
    return undefined;
  }
  const roles = item["roles"].filter(
    (role): role is string => typeof role === "string",
  );
  if (roles.length === 0) {
    return undefined;
  }
  const scope = typeof item["scope"] === "string" ? item["scope"] : undefined;
  const id = typeof item["id"] === "string" ? item["id"] : undefined;
  const within = isRecord(item["within"])
    ? Object.fromEntries(
        Object.entries(item["within"]).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : undefined;
  const onRecord = isRecord(item["on"]) ? item["on"] : undefined;
  const on =
    onRecord !== undefined &&
    typeof onRecord["resource"] === "string" &&
    typeof onRecord["id"] === "string"
      ? { resource: onRecord["resource"], id: onRecord["id"] }
      : undefined;
  if ((scope === undefined || id === undefined) && on === undefined) {
    return undefined;
  }
  const keep = item["keep"];
  if (
    keep !== undefined &&
    (!Array.isArray(keep) ||
      !keep.every((key) => typeof key === "string" && key !== ""))
  ) {
    return undefined;
  }
  return compact<Membership>({
    roles,
    scope,
    id,
    within,
    on,
    via: typeof item["via"] === "string" ? item["via"] : undefined,
    expiresAt:
      typeof item["expires_at"] === "number" ? item["expires_at"] : undefined,
    grantedBy:
      typeof item["granted_by"] === "string" ? item["granted_by"] : undefined,
    reason: typeof item["reason"] === "string" ? item["reason"] : undefined,
    member: memberOf(item["member"]),
    managedBy: item["managed_by"] === "idp" ? "idp" : undefined,
    entitlements: Array.isArray(item["entitlements"])
      ? item["entitlements"].filter(
          (seat): seat is string => typeof seat === "string",
        )
      : undefined,
    keep: keep === undefined ? undefined : asStrings(keep),
  });
}

function memberOf(value: unknown): { readonly group: string } | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    !Object.hasOwn(value, "group")
  ) {
    return undefined;
  }
  // SAFETY: an own property of a non-null object; its type is checked next.
  const group = (value as { readonly group: unknown }).group;
  return typeof group === "string" && group !== "" ? { group } : undefined;
}
