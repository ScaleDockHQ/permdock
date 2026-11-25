import { isRecord } from "./compact.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHORT_UUID = /^[A-Za-z0-9_-]{22}$/u;

/**
 * The keys of an entry the compact form can carry; anything else stays an
 * object.
 */
const COMPACT_KEYS = new Set(["scope", "id", "roles", "via"]);

/**
 * The compact `memberships` claim the hook writes: `s` lists the scopes and `r`
 * the roles and `v` the `via` labels the entries use, `e` holds one `[scope
 * index, id, via index or -1, ...role indexes]` array per plain entry, and `o`
 * keeps the entries that carry more than a scope, an id, roles and a `via`
 * (`within`, `grants`, `expires_at`, …) as objects. An id that is a UUID is its
 * 22 character base64url form; any other id is `=` and the text.
 */
export type CompactMemberships = {
  readonly s?: readonly string[];
  readonly r?: readonly string[];
  readonly v?: readonly string[];
  readonly e?: readonly (readonly (string | number)[])[];
  readonly o?: readonly unknown[];
};

export function shortId(id: string): string {
  if (!UUID.test(id)) {
    return `=${id}`;
  }
  const hex = id.replaceAll("-", "");
  let binary = "";
  for (let at = 0; at < hex.length; at += 2) {
    binary += String.fromCodePoint(Number.parseInt(hex.slice(at, at + 2), 16));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").slice(0, 22);
}

export function longId(short: string): string | undefined {
  if (short.startsWith("=")) {
    return short.slice(1);
  }
  if (!SHORT_UUID.test(short)) {
    return undefined;
  }
  const binary = atob(`${short.replaceAll("-", "+").replaceAll("_", "/")}==`);
  let hex = "";
  for (const char of binary) {
    hex += (char.codePointAt(0) ?? 0).toString(16).padStart(2, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function plain(
  entry: unknown,
): entry is {
  scope: string;
  id: string;
  roles: readonly string[];
  via?: string;
} {
  return (
    isRecord(entry) &&
    Object.keys(entry).every((key) => COMPACT_KEYS.has(key)) &&
    typeof entry["scope"] === "string" &&
    typeof entry["id"] === "string" &&
    (entry["via"] === undefined || typeof entry["via"] === "string") &&
    Array.isArray(entry["roles"]) &&
    entry["roles"].every((role) => typeof role === "string")
  );
}

/**
 * The compact claim for `entries`: the shape the generated hook writes. The
 * claims-size report and the tests use it to measure the claim without a
 * database.
 */
export function compactMemberships(
  entries: readonly unknown[],
): CompactMemberships | readonly unknown[] {
  if (entries.length === 0) {
    return [];
  }
  const scopes = new Set<string>();
  const roles = new Set<string>();
  const vias = new Set<string>();
  for (const entry of entries) {
    if (plain(entry)) {
      scopes.add(entry.scope);
      if (entry.via !== undefined) {
        vias.add(entry.via);
      }
      for (const role of entry.roles) {
        roles.add(role);
      }
    }
  }
  const s = [...scopes].toSorted();
  const r = [...roles].toSorted();
  const v = [...vias].toSorted();
  const e: (string | number)[][] = [];
  const o: unknown[] = [];
  for (const entry of entries) {
    if (plain(entry)) {
      e.push([
        s.indexOf(entry.scope),
        shortId(entry.id),
        entry.via === undefined ? -1 : v.indexOf(entry.via),
        ...entry.roles.map((role) => r.indexOf(role)),
      ]);
    } else {
      o.push(entry);
    }
  }
  return {
    ...(s.length === 0 ? {} : { s }),
    ...(r.length === 0 ? {} : { r }),
    ...(v.length === 0 ? {} : { v }),
    ...(e.length === 0 ? {} : { e }),
    ...(o.length === 0 ? {} : { o }),
  };
}

function list(item: unknown): readonly unknown[] {
  return Array.isArray(item) ? item : [];
}

function expandRow(
  row: unknown,
  scopes: readonly unknown[],
  roles: readonly unknown[],
  vias: readonly unknown[],
): unknown {
  if (!Array.isArray(row) || typeof row[1] !== "string") {
    return undefined;
  }
  const scope = scopes[Number(row[0])];
  const id = longId(row[1]);
  const via = vias[Number(row[2])];
  const held = row
    .slice(3)
    .map((index) => roles[Number(index)])
    .filter((role): role is string => typeof role === "string");
  return typeof scope === "string" && id !== undefined
    ? { scope, id, roles: held, ...(typeof via === "string" ? { via } : {}) }
    : undefined;
}

/**
 * The entry array of a `memberships` claim: an array stays as it is and the
 * compact object expands to the entries it stands for. A row that does not
 * resolve becomes `null`, which `readMemberships` drops and reports.
 */
export function expandMemberships(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const { s, r, v, e, o } = value;
  if (!["s", "r", "v", "e", "o"].some((key) => Array.isArray(value[key]))) {
    return value;
  }
  return [
    ...list(e).map((row) => expandRow(row, list(s), list(r), list(v)) ?? null),
    ...list(o),
  ];
}
