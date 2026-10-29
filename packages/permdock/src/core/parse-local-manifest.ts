import type { LocalSnapshotManifest } from "./snapshot-types.ts";

import { isRecord } from "./compact.ts";
import { isForbiddenKey } from "./paths.ts";

function isStrings(value: unknown): boolean {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function safeKeys(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every(safeKeys);
  }
  if (!isRecord(value)) {
    return true;
  }
  return Object.entries(value).every(
    ([key, item]) => !isForbiddenKey(key) && safeKeys(item),
  );
}

function isGrants(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (grant) =>
        isRecord(grant) &&
        typeof grant["permission"] === "string" &&
        (grant["effect"] === "allow" || grant["effect"] === "deny") &&
        (grant["role"] === null || typeof grant["role"] === "string") &&
        (isRecord(grant["to"]) || Array.isArray(grant["to"])),
    )
  );
}

function isGrantTable(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isGrants);
}

function isStringTable(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) && Object.values(value).every(isStrings))
  );
}

function isCustomTable(value: unknown): boolean {
  const reach = isRecord(value) ? value["includeReach"] : undefined;
  return (
    isRecord(value) &&
    isRecord(value["permissions"]) &&
    Object.values(value["permissions"]).every(
      (row) =>
        isRecord(row) &&
        isGrants(row["all"]) &&
        (row["levels"] === undefined || isGrantTable(row["levels"])) &&
        (row["reach"] === undefined || isStrings(row["reach"])) &&
        isStringTable(row["levelReach"]),
    ) &&
    isGrantTable(value["includes"]) &&
    (reach === undefined ||
      (isRecord(reach) && Object.values(reach).every(isStringTable)))
  );
}

function isAssignable(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const { roles, manage, permissions } = value;
  return (
    Array.isArray(roles) &&
    roles.every(
      (item) =>
        isRecord(item) &&
        typeof item["name"] === "string" &&
        typeof item["on"] === "string" &&
        isStrings(item["allows"]),
    ) &&
    isRecord(manage) &&
    isStrings(manage["roles"]) &&
    isStrings(manage["permissions"]) &&
    isStringTable(value["assigns"]) &&
    Array.isArray(permissions) &&
    permissions.every(
      (leaf) => isRecord(leaf) && typeof leaf["key"] === "string",
    ) &&
    isStringTable(value["levels"]) &&
    isStringTable(value["grants"])
  );
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isValue(value: unknown): boolean {
  return isRecord(value) && isText(value["column"]) !== isText(value["value"]);
}

function isColumn(value: unknown): boolean {
  if (!isRecord(value) || !isText(value["column"])) {
    return false;
  }
  const through = value["through"];
  const map = value["map"];
  if (through !== undefined && map !== undefined) {
    return false;
  }
  return (
    (through === undefined ||
      (isRecord(through) &&
        isText(through["table"]) &&
        isText(through["id"]) &&
        isText(through["column"]) &&
        (through["on"] === undefined ||
          (isRecord(through["on"]) &&
            Object.keys(through["on"]).length > 0 &&
            Object.entries(through["on"]).every(
              ([key, id]) => isText(key) && isText(id),
            ))))) &&
    (map === undefined ||
      (isRecord(map) &&
        Object.values(map).every((key) => key === null || isText(key))))
  );
}

function isMembershipRows(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const roles = value["roles"];
  return (
    isText(value["table"]) &&
    isColumn(value["user"]) &&
    isValue(value["scope"]) &&
    isText(value["id"]) &&
    (Array.isArray(roles)
      ? roles.length > 0 && roles.every(isColumn)
      : isRecord(roles) && isStrings(roles["value"])) &&
    (value["via"] === undefined || isValue(value["via"])) &&
    (value["expiresAt"] === undefined || isText(value["expiresAt"])) &&
    (value["disabledAt"] === undefined || isText(value["disabledAt"]))
  );
}

function isRows(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const { memberships, roles, customRoles, version } = value;
  return (
    Array.isArray(memberships) &&
    memberships.every(isMembershipRows) &&
    (roles === undefined ||
      (isRecord(roles) &&
        isText(roles["table"]) &&
        isText(roles["user"]) &&
        Array.isArray(roles["roles"]) &&
        roles["roles"].length > 0 &&
        roles["roles"].every(isColumn))) &&
    (customRoles === undefined ||
      (isRecord(customRoles) &&
        isText(customRoles["permissions"]) &&
        isText(customRoles["includes"]))) &&
    (version === undefined ||
      (isRecord(version) &&
        isText(version["table"]) &&
        isText(version["user"]) &&
        isText(version["version"])))
  );
}

/**
 * Whether `value` has the shape `localSnapshotManifest(policy)` writes, with no
 * prototype keys. A JSON import widens `v: 1` to `number`; this narrows it back
 * without a cast.
 */
export function parseLocalSnapshotManifest(
  value: unknown,
): value is LocalSnapshotManifest {
  return (
    isRecord(value) &&
    value["v"] === 1 &&
    isStrings(value["roles"]) &&
    (value["rank"] === undefined || isStrings(value["rank"])) &&
    (value["scopes"] === undefined ||
      (Array.isArray(value["scopes"]) && value["scopes"].every(isRecord))) &&
    (value["vocabulary"] === undefined || isRecord(value["vocabulary"])) &&
    isGrants(value["grants"]) &&
    isRecord(value["custom"]) &&
    Object.values(value["custom"]).every(isCustomTable) &&
    (value["rows"] === undefined || isRows(value["rows"])) &&
    (value["assignable"] === undefined || isAssignable(value["assignable"])) &&
    safeKeys(value)
  );
}
