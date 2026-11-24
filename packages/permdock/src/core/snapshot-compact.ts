import type { Condition } from "../conditions/ast.ts";
import type { Permission } from "./permission-types.ts";
import type {
  ClientBundle,
  Snapshot,
  ExpandedSnapshot,
  SnapshotAssignable,
  SnapshotGrant,
  SnapshotGrantRef,
  SnapshotGrantTerms,
  SnapshotStatic,
  SnapshotTypeLevel,
  SnapshotWireAssignable,
  SnapshotWireTerms,
  SnapshotWireTypeLevel,
} from "./snapshot-types.ts";
import type { Membership } from "./subject.ts";

import { canonicalJson } from "./canonical-json.ts";
import { isRecord } from "./compact.ts";
import { freezeDeep } from "./freeze.ts";
import { fromBits, toBits } from "./snapshot-bits.ts";
import { readMemberships, wireMemberships } from "./snapshot-members.ts";
import { requirementPlacer, withoutRequirement } from "./snapshot-requires.ts";

type RequiresTable = NonNullable<ExpandedSnapshot["requires"]>;

/**
 * Each distinct set of grant terms once, in order of first use, and the grants
 * as `{ permission, cond }` with runs of one permission merged. The bundle
 * form: its grants carry no membership.
 */
export function internGrants(
  grants: readonly (SnapshotWireTerms & { readonly permission: string })[],
): {
  readonly conditions: SnapshotWireTerms[];
  readonly grants: { permission: string; cond: number | number[] }[];
} {
  const indexes = new Map<string, number>();
  const conditions: SnapshotWireTerms[] = [];
  const compacted: { permission: string; cond: number | number[] }[] = [];
  for (const { permission, ...terms } of grants) {
    const key = canonicalJson(terms);
    let cond = indexes.get(key);
    if (cond === undefined) {
      cond = conditions.length;
      indexes.set(key, cond);
      conditions.push(terms);
    }
    const last = compacted.at(-1);
    if (last?.permission !== permission) {
      compacted.push({ permission, cond });
    } else if (typeof last.cond === "number") {
      last.cond = [last.cond, cond];
    } else {
      last.cond.push(cond);
    }
  }
  return { conditions, grants: compacted };
}

/** A condition with each `in` and `notIn` value passed through `at`. */
function mapInValues(
  condition: Condition,
  at: (value: unknown) => unknown,
): Condition {
  if (condition.op === "and" || condition.op === "or") {
    return {
      ...condition,
      conditions: condition.conditions.map((item) => mapInValues(item, at)),
    };
  }
  if (condition.op === "not") {
    return { ...condition, condition: mapInValues(condition.condition, at) };
  }
  if (condition.op === "in" || condition.op === "notIn") {
    // SAFETY: on the wire an `in` value may be a `{ list }` reference; expandGrants turns it back into the list.
    return { ...condition, value: at(condition.value) } as Condition;
  }
  return condition;
}

function isIdList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 1 &&
    value.every((item) => typeof item === "string")
  );
}

function mapTerms(
  terms: SnapshotWireTerms,
  at: (value: unknown) => unknown,
): SnapshotWireTerms {
  if (terms.where === undefined && terms.check === undefined) {
    return terms;
  }
  return {
    ...terms,
    ...(terms.where === undefined
      ? {}
      : { where: mapInValues(terms.where, at) }),
    ...(terms.check === undefined
      ? {}
      : { check: mapInValues(terms.check, at) }),
  };
}

/** Id lists used by more than one `in` value, each once, by canonical form. */
function sharedLists(terms: readonly SnapshotWireTerms[]): {
  readonly lists: (readonly string[])[];
  readonly index: ReadonlyMap<string, number>;
} {
  const counts = new Map<string, number>();
  const count = (value: unknown): unknown => {
    if (isIdList(value)) {
      const key = canonicalJson(value);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return value;
  };
  for (const item of terms) {
    mapTerms(item, count);
  }
  const lists: (readonly string[])[] = [];
  const index = new Map<string, number>();
  for (const [key, used] of counts) {
    if (used > 1) {
      index.set(key, lists.length);
      // SAFETY: the key is the canonical JSON of a string list counted above.
      lists.push(JSON.parse(key) as string[]);
    }
  }
  return { lists, index };
}

function pushRef(
  refs: SnapshotGrantRef[],
  term: number,
  member: number | undefined,
): void {
  if (member === undefined) {
    refs.push(term);
    return;
  }
  const last = refs.at(-1);
  if (typeof last === "object" && last[0] === term) {
    const held = last[1];
    refs[refs.length - 1] = [
      term,
      typeof held === "number" ? [held, member] : [...held, member],
    ];
    return;
  }
  refs.push([term, member]);
}

function wireAssignable(entries: readonly SnapshotAssignable[] | undefined): {
  readonly permissions?: readonly Permission[];
  readonly assignable?: readonly SnapshotWireAssignable[];
} {
  if (entries === undefined) {
    return {};
  }
  const table: Permission[] = [];
  const at = new Map<string, number>();
  const assignable = entries.map((entry): SnapshotWireAssignable => ({
    ...entry,
    permissions: entry.permissions.map((leaf) => {
      let index = at.get(leaf.key);
      if (index === undefined) {
        index = table.length;
        at.set(leaf.key, index);
        table.push(leaf);
      }
      return index;
    }),
  }));
  return { permissions: table, assignable };
}

/** The `requires` table with keys of the same holding written once. */
function wireRequires(table: RequiresTable | undefined): Snapshot["requires"] {
  if (table === undefined) {
    return undefined;
  }
  const groups = new Map<
    string,
    { keys: string[]; held: true | readonly number[] }
  >();
  for (const [key, held] of Object.entries(table)) {
    const canon = canonicalJson(held);
    const group = groups.get(canon) ?? { keys: [], held };
    group.keys.push(key);
    groups.set(canon, group);
  }
  return [...groups.values()].map(({ keys, held }) => [keys, held] as const);
}

function wireTypeLevel(
  table: SnapshotTypeLevel | undefined,
  bundle: ClientBundle | undefined,
): SnapshotTypeLevel | SnapshotWireTypeLevel | undefined {
  if (table === undefined || bundle === undefined) {
    return table;
  }
  const granted = toBits(table.granted, bundle.keys);
  const approval =
    table.approval === undefined
      ? undefined
      : toBits(table.approval, bundle.keys);
  const endpoint =
    table.endpoint === undefined
      ? undefined
      : toBits(table.endpoint, bundle.keys);
  if (
    granted === undefined ||
    (table.approval !== undefined && approval === undefined) ||
    (table.endpoint !== undefined && endpoint === undefined)
  ) {
    return table;
  }
  return {
    bits: true,
    granted,
    ...(approval === undefined ? {} : { approval }),
    ...(endpoint === undefined ? {} : { endpoint }),
  };
}

/**
 * The wire form of an expanded snapshot. Each distinct set of grant terms is
 * written once without its membership or its `requires` ids, a grant names the
 * memberships it holds through by index, memberships share their shapes, and an
 * id list used twice is written once in `lists`, so the same subject always
 * serialises to the same bytes. `held` names the grants left to a
 * `ClientBundle`; with `bundle`, the vocabulary, scopes and key table the
 * bundle carries are left out and `bundle` names its digest.
 */
export function compactSnapshot(
  snapshot: ExpandedSnapshot,
  held?: SnapshotStatic,
  bundle?: ClientBundle,
): Snapshot {
  const {
    grants,
    assignable,
    requires,
    typeLevel,
    subject,
    v: _v,
    ...rest
  } = snapshot;
  const memberships = subject.principal?.memberships ?? [];
  const memberAt = new Map<string, number>();
  for (const [at, membership] of memberships.entries()) {
    const key = canonicalJson(membership);
    if (!memberAt.has(key)) {
      memberAt.set(key, at);
    }
  }
  const stripped = grants.map(({ permission, membership, ...bare }) => {
    const member =
      membership === undefined
        ? undefined
        : memberAt.get(canonicalJson(membership));
    const terms = withoutRequirement(bare, requires, memberships);
    return {
      permission,
      member,
      terms:
        membership !== undefined && member === undefined
          ? { ...terms, membership }
          : terms,
    };
  });
  const { lists, index: listAt } = sharedLists(
    stripped.map(({ terms }) => terms),
  );
  const toRef = (value: unknown): unknown => {
    const at = isIdList(value) ? listAt.get(canonicalJson(value)) : undefined;
    return at === undefined ? value : { list: at };
  };
  const termAt = new Map<string, number>();
  const conditions: SnapshotWireTerms[] = [];
  const compacted: { permission: string; refs: SnapshotGrantRef[] }[] = [];
  for (const { permission, member, terms: unmapped } of stripped) {
    const terms = mapTerms(unmapped, toRef);
    const key = canonicalJson(terms);
    let term = termAt.get(key);
    if (term === undefined) {
      term = conditions.length;
      termAt.set(key, term);
      conditions.push(terms);
    }
    let last = compacted.at(-1);
    if (last?.permission !== permission) {
      last = { permission, refs: [] };
      compacted.push(last);
    }
    pushRef(last.refs, term, member);
  }
  const sameAsBundle = (key: "vocabulary" | "scopes"): boolean =>
    bundle?.[key] !== undefined &&
    canonicalJson(bundle[key]) === canonicalJson(rest[key]);
  const { vocabulary, scopes, ...header } = rest;
  const leftVocabulary = vocabulary !== undefined && sameAsBundle("vocabulary");
  const leftScopes = scopes !== undefined && sameAsBundle("scopes");
  const table = wireTypeLevel(typeLevel, bundle);
  const usesBundle =
    leftVocabulary || leftScopes || (table !== undefined && "bits" in table);
  const principal = subject.principal;
  const shaped =
    principal?.memberships === undefined
      ? undefined
      : wireMemberships(principal.memberships);
  const wireRequired = wireRequires(requires);
  return freezeDeep({
    v: 2 as const,
    ...header,
    subject:
      principal === null || shaped === undefined
        ? subject
        : {
            ...subject,
            principal: { ...principal, memberships: shaped.memberships },
          },
    ...(shaped === undefined || shaped.shapes.length === 0
      ? {}
      : { shapes: shaped.shapes }),
    ...(vocabulary === undefined || leftVocabulary ? {} : { vocabulary }),
    ...(scopes === undefined || leftScopes ? {} : { scopes }),
    ...(table === undefined ? {} : { typeLevel: table }),
    ...(usesBundle && bundle !== undefined ? { bundle: bundle.digest } : {}),
    ...wireAssignable(assignable),
    ...(wireRequired === undefined ? {} : { requires: wireRequired }),
    conditions,
    ...(lists.length === 0 ? {} : { lists }),
    grants: compacted.map(({ permission, refs }) => {
      const [only] = refs;
      return {
        permission,
        cond: refs.length === 1 && typeof only === "number" ? only : refs,
      };
    }),
    ...(held === undefined ? {} : { static: held }),
  });
}

function bad(detail: string): Error {
  return new Error(`PermDock: snapshot ${detail}`);
}

function indexInto<T>(list: readonly T[], value: unknown): T | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? list[value]
    : undefined;
}

/** The memberships of a wire document, with `[shape, id]` entries resolved. */
function membershipsOf(
  record: Readonly<Record<string, unknown>>,
): readonly Membership[] {
  const subject = record["subject"];
  const principal = isRecord(subject) ? subject["principal"] : undefined;
  return readMemberships(
    isRecord(principal) ? principal["memberships"] : undefined,
    record["shapes"],
  );
}

/**
 * The `requires` table of a wire document in the flat form. Throws on an entry
 * that is not `[keys, true | membership indexes]`.
 */
function requiresOf(
  record: Readonly<Record<string, unknown>>,
  count: number,
): RequiresTable | undefined {
  const wire = record["requires"];
  if (wire === undefined) {
    return undefined;
  }
  if (!Array.isArray(wire)) {
    throw bad("requires must be a list");
  }
  const table: Record<string, true | readonly number[]> = {};
  const entries: readonly unknown[] = wire;
  for (const entry of entries) {
    const pair: readonly unknown[] = Array.isArray(entry) ? entry : [];
    const keys = pair[0];
    const held = pair[1];
    const indexes =
      held === true || isIndexList(held, count) ? held : undefined;
    if (!isStringList(keys) || indexes === undefined) {
      throw bad("requires entries must be [keys, true or membership indexes]");
    }
    for (const key of keys) {
      table[key] = indexes;
    }
  }
  return table;
}

function isStringList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === "string")
  );
}

function isIndexList(
  value: unknown,
  count: number,
): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.every(
      (at: unknown) =>
        typeof at === "number" && Number.isInteger(at) && at >= 0 && at < count,
    )
  );
}

/** A wire condition with each `{ list }` reference replaced by its list. */
function listsIn(condition: unknown, lists: readonly unknown[]): unknown {
  if (!isRecord(condition)) {
    return condition;
  }
  const op = condition["op"];
  if ((op === "and" || op === "or") && Array.isArray(condition["conditions"])) {
    return {
      ...condition,
      conditions: condition["conditions"].map((item: unknown) =>
        listsIn(item, lists),
      ),
    };
  }
  if (op === "not") {
    return { ...condition, condition: listsIn(condition["condition"], lists) };
  }
  const value = condition["value"];
  if ((op === "in" || op === "notIn") && isRecord(value) && "list" in value) {
    const list = indexInto(lists, value["list"]);
    if (!isIdList(list)) {
      throw bad("has an in value that is not an index into lists");
    }
    return { ...condition, value: list };
  }
  return condition;
}

function termsWithLists(
  terms: Readonly<Record<string, unknown>>,
  lists: readonly unknown[],
): Readonly<Record<string, unknown>> {
  if (lists.length === 0) {
    return terms;
  }
  return {
    ...terms,
    ...(terms["where"] === undefined
      ? {}
      : { where: listsIn(terms["where"], lists) }),
    ...(terms["check"] === undefined
      ? {}
      : { check: listsIn(terms["check"], lists) }),
  };
}

/** Terms with their lists resolved and their requirement placed. */
function readTerms(
  terms: Readonly<Record<string, unknown>>,
  lists: readonly unknown[],
  place: (terms: SnapshotWireTerms) => Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  // SAFETY: a condition entry holds the terms of a grant; the other fields are not validated here.
  return place(termsWithLists(terms, lists) as SnapshotWireTerms);
}

/**
 * The grants of a wire document as the `Snapshot` model holds them. Throws on a
 * `conditions` that is not a list of objects, a reference that is not an index
 * into `conditions`, `lists` or the memberships, so a malformed document never
 * reads as a narrower grant.
 */
export function expandGrants(record: Readonly<Record<string, unknown>>): {
  readonly grants: readonly SnapshotGrant[];
} {
  const conditions = record["conditions"];
  const grants = record["grants"];
  const lists = record["lists"] ?? [];
  if (!Array.isArray(conditions) || !conditions.every(isRecord)) {
    throw bad("conditions must be a list of objects");
  }
  if (!Array.isArray(grants)) {
    throw bad("grants must be a list");
  }
  if (!Array.isArray(lists) || !lists.every(isIdList)) {
    throw bad("lists must be a list of id lists");
  }
  const memberships = membershipsOf(record);
  const table = requiresOf(record, memberships.length);
  const place = requirementPlacer(table, memberships);
  const resolved = conditions.map((terms) => readTerms(terms, lists, place));
  return {
    grants: grants.flatMap((grant: unknown): SnapshotGrant[] => {
      if (!isRecord(grant) || typeof grant["permission"] !== "string") {
        throw bad("grant must be { permission, cond }");
      }
      const permission = grant["permission"];
      const cond = grant["cond"];
      const refs: unknown[] = Array.isArray(cond) ? cond : [cond];
      if (refs.length === 0) {
        throw bad(`grant '${permission}' has an empty cond list`);
      }
      return refs.flatMap((ref): SnapshotGrant[] => {
        const pair: readonly unknown[] = Array.isArray(ref) ? ref : [ref];
        const term = pair[0];
        const held = pair[1];
        const terms = indexInto(resolved, term);
        if (terms === undefined) {
          throw bad(
            `grant '${permission}' has a cond that is not an index into conditions`,
          );
        }
        if (held === undefined) {
          // SAFETY: a condition entry holds the terms of a grant; the other fields are not validated here.
          return [{ permission, ...terms } as SnapshotGrant];
        }
        const at: unknown[] = Array.isArray(held) ? held : [held];
        return at.map((index): SnapshotGrant => {
          const membership = indexInto(memberships, index);
          if (!isRecord(membership)) {
            throw bad(
              `grant '${permission}' has a membership that is not an index into subject.principal.memberships`,
            );
          }
          // SAFETY: as above; the membership is an entry of the principal's list.
          return { permission, ...terms, membership } as SnapshotGrant;
        });
      });
    }),
  };
}

/** `assignable` with each permission index resolved against `permissions`. */
function expandAssignable(
  snapshot: Snapshot,
): readonly SnapshotAssignable[] | undefined {
  const table = snapshot.permissions ?? [];
  return snapshot.assignable?.map((entry): SnapshotAssignable => ({
    ...entry,
    permissions: entry.permissions.map((index) => {
      const leaf = indexInto(table, index);
      if (leaf === undefined) {
        throw bad(
          "assignable has a permission that is not an index into permissions",
        );
      }
      return leaf;
    }),
  }));
}

/**
 * The bundle a snapshot's left-out data comes from, or `stale` when the
 * snapshot names a bundle digest and `bundle` is absent or another. A stale
 * read resolves nothing, so a mismatched bundle never supplies the scopes or
 * key table a grant is checked against.
 */
function bundleFor(
  snapshot: Snapshot,
  bundle: ClientBundle | undefined,
): ClientBundle | "stale" | undefined {
  if (snapshot.bundle === undefined) {
    return bundle;
  }
  return bundle?.digest === snapshot.bundle ? bundle : "stale";
}

function readTypeLevel(
  table: Snapshot["typeLevel"],
  bundle: ClientBundle | undefined,
): SnapshotTypeLevel | undefined {
  if (table === undefined || !("bits" in table)) {
    return table;
  }
  if (bundle === undefined) {
    return undefined;
  }
  return {
    granted: fromBits(table.granted, bundle.keys),
    ...(table.approval === undefined
      ? {}
      : { approval: fromBits(table.approval, bundle.keys) }),
    ...(table.endpoint === undefined
      ? {}
      : { endpoint: fromBits(table.endpoint, bundle.keys) }),
  };
}

function bundleGrants(
  bundle: ClientBundle,
  grants: ClientBundle["roles"][string]["grants"],
  place: (terms: SnapshotWireTerms) => SnapshotGrantTerms,
  membership: Membership | undefined,
  out: SnapshotGrant[],
): void {
  const conditions = bundle.conditions;
  const add = (permission: string, index: number): void => {
    const terms = conditions[index];
    if (terms !== undefined) {
      out.push(
        membership === undefined
          ? { permission, ...place(terms) }
          : { permission, ...place(terms), membership },
      );
    }
  };
  for (const { permission, cond } of grants) {
    if (typeof cond === "number") {
      add(permission, cond);
    } else {
      for (const index of cond) {
        add(permission, index);
      }
    }
  }
}

/**
 * The grants `static` refers to, from `bundle`. A role the bundle lacks, or
 * holds under another digest, resolves to nothing, so a stale bundle denies.
 */
function staticGrants(
  snapshot: Snapshot,
  header: Omit<ExpandedSnapshot, "grants">,
  bundle: ClientBundle | undefined,
): readonly SnapshotGrant[] {
  const held = snapshot.static;
  if (held === undefined || bundle === undefined) {
    return [];
  }
  const memberships = header.subject.principal?.memberships ?? [];
  const place = requirementPlacer(header.requires, memberships);
  const out: SnapshotGrant[] = [];
  if (held.shared !== undefined && bundle.shared?.digest === held.shared) {
    bundleGrants(bundle, bundle.shared.grants, place, undefined, out);
  }
  for (const [role, index] of held.held) {
    const entry = Object.hasOwn(bundle.roles, role)
      ? bundle.roles[role]
      : undefined;
    const expected = Object.hasOwn(held.digests, role)
      ? held.digests[role]
      : undefined;
    const membership = index === null ? undefined : memberships[index];
    if (
      entry !== undefined &&
      entry.digest === expected &&
      (index === null || membership !== undefined)
    ) {
      bundleGrants(bundle, entry.grants, place, membership, out);
    }
  }
  return out;
}

function readHeader(
  snapshot: Snapshot,
  bundle: ClientBundle | undefined,
): Omit<ExpandedSnapshot, "grants"> {
  const {
    conditions: _conditions,
    lists: _lists,
    grants: _grants,
    static: _static,
    permissions: _permissions,
    assignable: _assignable,
    shapes: _shapes,
    requires: _requires,
    bundle: _bundle,
    typeLevel: wireTable,
    subject,
    ...rest
  } = snapshot;
  const memberships = membershipsOf(snapshot);
  const requires = requiresOf(snapshot, memberships.length);
  const vocabulary = rest.vocabulary ?? bundle?.vocabulary;
  const scopes = rest.scopes ?? bundle?.scopes;
  const assignable = expandAssignable(snapshot);
  const typeLevel = readTypeLevel(wireTable, bundle);
  const principal = subject.principal;
  return {
    ...rest,
    v: 2,
    subject:
      principal?.memberships === undefined
        ? {
            ...subject,
            // SAFETY: a principal without memberships has the flat shape.
            principal: principal as ExpandedSnapshot["subject"]["principal"],
          }
        : { ...subject, principal: { ...principal, memberships } },
    ...(vocabulary === undefined ? {} : { vocabulary }),
    ...(scopes === undefined ? {} : { scopes }),
    ...(assignable === undefined ? {} : { assignable }),
    ...(typeLevel === undefined ? {} : { typeLevel }),
    ...(requires === undefined ? {} : { requires }),
  };
}

/**
 * Checks every index of a wire snapshot's header without its bundle, for
 * `parseSnapshot`: memberships, `requires` and `assignable`.
 */
export function checkHeader(snapshot: Snapshot): void {
  const memberships = membershipsOf(snapshot);
  requiresOf(snapshot, memberships.length);
  expandAssignable(snapshot);
}

/**
 * Everything of a wire snapshot but its grants, in the flat form: the
 * vocabulary, scopes and key table from `bundle` when the snapshot left them to
 * it.
 */
export function snapshotHeader(
  snapshot: Snapshot,
  options: { readonly bundle?: ClientBundle | undefined } = {},
): Omit<ExpandedSnapshot, "grants"> {
  const bundle = bundleFor(snapshot, options.bundle);
  return readHeader(snapshot, bundle === "stale" ? undefined : bundle);
}

/**
 * The flat form the evaluator reads, from a validated wire `Snapshot`. A
 * snapshot built with `omitStatic` needs the `bundle` its server generated;
 * grants it refers to are appended after the inline ones.
 */
export function expandSnapshot(
  snapshot: Snapshot,
  options: { readonly bundle?: ClientBundle | undefined } = {},
): ExpandedSnapshot {
  const bundle = bundleFor(snapshot, options.bundle);
  if (bundle === "stale") {
    return freezeDeep({ ...readHeader(snapshot, undefined), grants: [] });
  }
  const header = readHeader(snapshot, bundle);
  const inline = expandGrants(snapshot).grants;
  const held = staticGrants(snapshot, header, bundle);
  return freezeDeep({
    ...header,
    grants: held.length === 0 ? inline : [...inline, ...held],
  });
}

/**
 * Every grant of a wire snapshot with its full terms and membership, for tests
 * and debugging. A snapshot built with `omitStatic` needs its `bundle`.
 */
export function readSnapshot(
  snapshot: Snapshot,
  options: { readonly bundle?: ClientBundle | undefined } = {},
): ExpandedSnapshot {
  return expandSnapshot(snapshot, options);
}
