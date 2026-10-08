import type { LocalSnapshotManifest } from "./interfaces.ts";

import { isForbiddenKey } from "./paths.ts";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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

function isCustomTable(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value["permissions"]) &&
    Object.values(value["permissions"]).every(
      (row) =>
        isRecord(row) &&
        isGrants(row["all"]) &&
        (row["levels"] === undefined || isGrantTable(row["levels"])),
    ) &&
    isGrantTable(value["includes"])
  );
}

/**
 * Whether `value` has the shape `localSnapshotManifest(policy)` writes, with
 * no prototype keys. A JSON import widens `v: 1` to `number`; this narrows it
 * back without a cast.
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
    safeKeys(value)
  );
}
