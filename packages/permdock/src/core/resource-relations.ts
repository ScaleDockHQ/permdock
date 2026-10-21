import type {
  ComputedRelation,
  EdgeGroup,
  EdgeGroupEntry,
  EdgeGroups,
  EdgeMatch,
  EdgeRelation,
  FieldRelation,
  PrincipalRelation,
  ResourceLink,
  ResourceNode,
  ResourceParent,
  ResourceRelation,
  ResourceRelationInput,
  ResourceRestricted,
} from "./permission-types.ts";

import { assertSafeKey } from "./paths.ts";

/** The edge's group resources with their relation and id column. */
export function groupEntries(spec: EdgeRelation): readonly EdgeGroupEntry[] {
  const groups = spec.groups;
  if (groups === undefined) {
    return [];
  }
  return Object.entries(groups.resources).map(([resource, group]) =>
    typeof group === "string"
      ? {
          resource,
          relation: group,
          subject: spec.subject ?? "user_id",
          typed: false,
        }
      : {
          resource,
          relation: group.relation,
          subject: group.subject ?? spec.subject ?? "user_id",
          typed: group.subject !== undefined,
        },
  );
}

export function restrictedStops(
  node: ResourceNode | undefined,
  path: string,
): boolean {
  return (
    node?.restricted !== undefined &&
    (node.restrictedStops === undefined || node.restrictedStops.includes(path))
  );
}

export function restrictedFor(
  node: ResourceNode | undefined,
  path: string,
): string | undefined {
  return restrictedStops(node, path) ? node?.restricted : undefined;
}

export function isFieldRelation(
  relation: ResourceRelation | undefined,
): relation is FieldRelation {
  return relation !== undefined && "field" in relation;
}

export function isEdgeRelation(
  relation: ResourceRelation | undefined,
): relation is EdgeRelation {
  return relation !== undefined && "edge" in relation;
}

export function isPrincipalRelation(
  relation: ResourceRelation | undefined,
): relation is PrincipalRelation {
  return relation !== undefined && "principal" in relation;
}

export function isComputedRelation(
  relation: ResourceRelation | undefined,
): relation is ComputedRelation {
  return (
    relation !== undefined &&
    !("field" in relation) &&
    !("edge" in relation) &&
    !("principal" in relation)
  );
}

/**
 * The relations whose holders hold `name` on `node`: `name` itself when it
 * has a source, then everything it includes, transitively, each once.
 * `definePermissions` rejects cycles and unknown names, so this terminates.
 */
export function expandRelation(
  node: ResourceNode | undefined,
  name: string,
): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (current: string): void => {
    if (seen.has(current)) {
      return;
    }
    seen.add(current);
    const spec = node?.relations[current];
    if (spec === undefined) {
      return;
    }
    if (!isComputedRelation(spec)) {
      out.push(current);
    }
    for (const included of spec.includes ?? []) {
      visit(included);
    }
  };
  visit(name);
  return out;
}

/** Whether `node` names itself as its parent (nested folders, sub-teams, reporting lines). */
export function isSelfParented(node: ResourceNode | undefined): boolean {
  return node?.parent !== undefined && node.parent.resource === node.name;
}

export const RESOURCE_NAME: RegExp = /^[A-Za-z][A-Za-z0-9_-]*$/u;

/** Level names ride claims and grant keys (`key@level`), so they stay SQL- and claim-safe. */
export const LEVEL_NAME: RegExp = /^[a-z][a-z0-9_]*$/u;

const EDGE_TABLE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/u;

export function restrictedStopsOf(
  name: string,
  option: ResourceRestricted,
  parent: ResourceParent | undefined,
  links: Readonly<Record<string, ResourceLink>>,
): readonly string[] | undefined {
  if (option.stops === undefined) {
    return undefined;
  }
  if (!Array.isArray(option.stops) || option.stops.length === 0) {
    throw new Error(
      `PermDock: resource "${name}" restricted.stops must list 'parent' or link names`,
    );
  }
  const stops = new Set<string>();
  for (const path of option.stops) {
    if (typeof path !== "string") {
      throw new TypeError(
        `PermDock: resource "${name}" restricted.stops must list 'parent' or link names`,
      );
    }
    if (
      path === "parent" ? parent === undefined : !Object.hasOwn(links, path)
    ) {
      throw new Error(
        `PermDock: resource "${name}" restricted.stops names '${path}', which it does not declare`,
      );
    }
    stops.add(path);
  }
  return Object.freeze([...stops].toSorted());
}

export function normaliseRelation(
  resourceName: string,
  relationName: string,
  spec: ResourceRelationInput,
): ResourceRelation {
  if (typeof spec === "string") {
    assertSafeKey(spec, "relation field");
    return { field: spec };
  }
  const label = `relation '${relationName}' on '${resourceName}'`;
  const includes = normaliseIncludes(label, spec.includes);
  const kinds = ["field", "edge", "principal"].filter((kind) => kind in spec);
  if (kinds.length === 0 && includes !== undefined) {
    return { includes };
  }
  if (kinds.length !== 1) {
    throw new Error(
      `PermDock: ${label} needs exactly one of field, edge, principal or includes`,
    );
  }
  const withIncludes = includes === undefined ? {} : { includes };
  if (isEdgeRelation(spec)) {
    if (!EDGE_TABLE.test(spec.edge)) {
      throw new Error(
        `PermDock: ${label} has an unsafe edge table '${spec.edge}'`,
      );
    }
    for (const column of [spec.object, spec.subject, spec.expiresAt]) {
      if (column !== undefined) {
        assertSafeKey(column, "edge column");
      }
    }
    return {
      edge: spec.edge,
      ...(spec.object === undefined ? {} : { object: spec.object }),
      ...(spec.subject === undefined ? {} : { subject: spec.subject }),
      ...(spec.expiresAt === undefined ? {} : { expiresAt: spec.expiresAt }),
      ...(spec.match === undefined
        ? {}
        : { match: normaliseMatch(label, spec.match) }),
      ...(spec.groups === undefined
        ? {}
        : { groups: normaliseGroups(label, spec.groups) }),
      ...withIncludes,
    };
  }
  if (isPrincipalRelation(spec)) {
    assertSafeKey(spec.principal, "relation principal");
    for (const column of [spec.period?.startsAt, spec.period?.expiresAt]) {
      if (column !== undefined) {
        assertSafeKey(column, "relation period");
      }
    }
    return spec.period === undefined
      ? { principal: spec.principal, ...withIncludes }
      : {
          principal: spec.principal,
          period: { ...spec.period },
          ...withIncludes,
        };
  }
  // SAFETY: exactly one kind key is present and edge and principal returned above, so it is field.
  const field = spec as FieldRelation;
  assertSafeKey(field.field, "relation field");
  if (field.memberOf !== undefined && includes !== undefined) {
    throw new Error(
      `PermDock: ${label} is a memberOf relation and cannot include others`,
    );
  }
  return field.memberOf === undefined
    ? { field: field.field, ...withIncludes }
    : { field: field.field, memberOf: field.memberOf };
}

function normaliseIncludes(
  label: string,
  includes: unknown,
): readonly string[] | undefined {
  if (includes === undefined) {
    return undefined;
  }
  if (!Array.isArray(includes) || includes.length === 0) {
    throw new Error(
      `PermDock: ${label} includes must be a non-empty list of relation names`,
    );
  }
  // SAFETY: a widening from any, so each name is checked as a string below.
  for (const name of includes as readonly unknown[]) {
    if (typeof name !== "string") {
      throw new TypeError(`PermDock: ${label} includes a non-string name`);
    }
    assertSafeKey(name, "included relation");
  }
  // SAFETY: the loop above throws unless every name is a string.
  return [...new Set(includes as readonly string[])];
}

function normaliseMatch(label: string, match: EdgeMatch): EdgeMatch {
  const out: Record<string, string | number | boolean> = {};
  const columns = Object.keys(match);
  if (columns.length === 0) {
    throw new Error(`PermDock: ${label} match needs at least one column`);
  }
  for (const column of columns) {
    assertSafeKey(column, "edge match column");
    const value = match[column];
    if (
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      !(typeof value === "number" && Number.isFinite(value))
    ) {
      throw new TypeError(
        `PermDock: ${label} match '${column}' must be a string, a finite number or a boolean`,
      );
    }
    out[column] = value;
  }
  return out;
}

function normaliseGroups(label: string, groups: EdgeGroups): EdgeGroups {
  if (groups.column !== undefined) {
    assertSafeKey(groups.column, "edge groups column");
  }
  const resources: Record<string, EdgeGroup> = {};
  const names = Object.keys(groups.resources);
  if (names.length === 0) {
    throw new Error(`PermDock: ${label} groups needs at least one resource`);
  }
  for (const name of names) {
    assertSafeKey(name, "group resource");
    const group: unknown = groups.resources[name];
    if (typeof group === "string") {
      assertSafeKey(group, "group relation");
      if (groups.column === undefined) {
        throw new Error(
          `PermDock: ${label} groups '${name}' needs its own subject column, or groups needs a column naming the resource`,
        );
      }
      resources[name] = group;
      continue;
    }
    if (group === null || typeof group !== "object") {
      throw new TypeError(
        `PermDock: ${label} groups '${name}' must name a relation`,
      );
    }
    const relationName = "relation" in group ? group.relation : undefined;
    if (typeof relationName !== "string") {
      throw new TypeError(
        `PermDock: ${label} groups '${name}' must name a relation`,
      );
    }
    assertSafeKey(relationName, "group relation");
    const subject = "subject" in group ? group.subject : undefined;
    if (subject !== undefined && typeof subject !== "string") {
      throw new TypeError(
        `PermDock: ${label} groups '${name}' subject must be a column name`,
      );
    }
    if (subject !== undefined) {
      assertSafeKey(subject, "group subject column");
    } else if (groups.column === undefined) {
      throw new Error(
        `PermDock: ${label} groups '${name}' needs its own subject column, or groups needs a column naming the resource`,
      );
    }
    resources[name] =
      subject === undefined
        ? { relation: relationName }
        : { relation: relationName, subject };
  }
  if (groups.direct !== undefined && groups.column === undefined) {
    throw new Error(
      `PermDock: ${label} groups direct needs a column to compare it with`,
    );
  }
  if (groups.direct !== undefined && groups.direct in resources) {
    throw new Error(
      `PermDock: ${label} groups direct '${groups.direct}' is also a group resource`,
    );
  }
  return {
    ...(groups.column === undefined ? {} : { column: groups.column }),
    resources,
    ...(groups.direct === undefined ? {} : { direct: groups.direct }),
  };
}

/** An included relation must exist on the same resource, be tenancy-free and never include itself back. */
export function assertIncludes(node: ResourceNode): void {
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string, path: readonly string[]): void => {
    if (state.get(name) === "done") {
      return;
    }
    if (state.get(name) === "visiting") {
      throw new Error(
        `PermDock: relation includes on '${node.name}' form a cycle: ${[...path, name].join(" -> ")}`,
      );
    }
    state.set(name, "visiting");
    for (const included of node.relations[name]?.includes ?? []) {
      const target = node.relations[included];
      if (target === undefined) {
        throw new Error(
          `PermDock: relation '${name}' on '${node.name}' includes '${included}', which '${node.name}' does not declare`,
        );
      }
      if (isFieldRelation(target) && target.memberOf !== undefined) {
        throw new Error(
          `PermDock: relation '${name}' on '${node.name}' includes the memberOf relation '${included}'; scopes are tenancy, not the object graph`,
        );
      }
      visit(included, [...path, name]);
    }
    state.set(name, "done");
  };
  for (const name of Object.keys(node.relations)) {
    visit(name, []);
  }
}

function assertGroupTarget(
  registry: ReadonlyMap<string, ResourceNode>,
  node: ResourceNode,
  relationName: string,
  spec: ResourceRelation,
  target: string,
  targetRelation: string,
): void {
  const label = `relation '${relationName}' on '${node.name}' groups '${target}'`;
  const targetSpec = registry.get(target)?.relations[targetRelation];
  if (targetSpec === undefined) {
    throw new Error(
      `PermDock: ${label} names '${target}#${targetRelation}', which is not declared`,
    );
  }
  if (isFieldRelation(targetSpec) && targetSpec.memberOf !== undefined) {
    throw new Error(
      `PermDock: ${label} names a memberOf relation; scopes are tenancy, not the object graph`,
    );
  }
  if (
    target === node.name &&
    (targetRelation !== relationName || spec.includes !== undefined)
  ) {
    throw new Error(
      `PermDock: ${label}: a group on its own resource must name the same relation, which includes nothing`,
    );
  }
}

/**
 * Links and group targets name declared resources and relations. Groups may
 * nest within one resource (teams in teams) through the same relation, which
 * then includes nothing, so SQL can walk it with one bounded recursive query;
 * a group cycle across resources is rejected.
 */
export function assertGraphTargets(
  registry: ReadonlyMap<string, ResourceNode>,
): void {
  const edges = new Map<string, Set<string>>();
  for (const node of registry.values()) {
    for (const [linkName, link] of Object.entries(node.links)) {
      if (!registry.has(link.resource)) {
        throw new Error(
          `PermDock: link '${linkName}' on '${node.name}' names the undeclared resource '${link.resource}'`,
        );
      }
    }
    for (const [relationName, spec] of Object.entries(node.relations)) {
      if (!isEdgeRelation(spec) || spec.groups === undefined) {
        continue;
      }
      for (const { resource: target, relation: targetRelation } of groupEntries(
        spec,
      )) {
        assertGroupTarget(
          registry,
          node,
          relationName,
          spec,
          target,
          targetRelation,
        );
        if (target !== node.name) {
          const out = edges.get(node.name) ?? new Set<string>();
          out.add(target);
          edges.set(node.name, out);
        }
      }
    }
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string): void => {
    if (state.get(name) === "done") {
      return;
    }
    if (state.get(name) === "visiting") {
      throw new Error(
        `PermDock: edge groups form a cycle across resources through '${name}'`,
      );
    }
    state.set(name, "visiting");
    for (const next of edges.get(name) ?? []) {
      visit(next);
    }
    state.set(name, "done");
  };
  for (const name of edges.keys()) {
    visit(name);
  }
}
