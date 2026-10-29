import type { Approver, ApproverInput } from "./approvers.ts";
import type { GranteeInput } from "./grantee.ts";
import type { ResourceNode } from "./permission-types.ts";
import type {
  ApprovalEscalation,
  ApprovalCombine,
  ApprovalFallback,
  ApprovalMode,
  ApprovalOption,
  ApprovalRequirement,
  ApprovalStage,
  Grant,
} from "./policy-types.ts";

import {
  approverLeaves,
  flattenApprovers,
  isAnyOfInput,
  isManagerApprover,
  isPermissionApprover,
  isUserApprover,
  manager,
  user,
} from "./approvers.ts";
import { compact, isReadonlyArray } from "./compact.ts";
import { asGrantee, authenticated } from "./grantee.ts";
import { isSelfParented } from "./resource-relations.ts";
import { assertDuration } from "./time.ts";

/**
 * Every approver a requirement names: `by`, each stage and its escalation, and
 * `escalation.to`, inside `anyOf` groups too.
 */
function approversOf(requirement: ApprovalRequirement): readonly Approver[] {
  return [
    ...approverLeaves(requirement.by),
    ...(requirement.stages ?? []).flatMap((stage) =>
      approverLeaves(stage.by).concat(approverLeaves(stage.escalation?.to)),
    ),
    ...approverLeaves(requirement.escalation?.to),
  ];
}

export function asApprover(
  input: ApproverInput,
): Approver | readonly Approver[] {
  if (isPermissionApprover(input)) {
    if (typeof input.permission !== "string" || input.permission === "") {
      throw new Error("PermDock: a permission approver needs a permission key");
    }
    return Object.freeze({
      kind: "permission" as const,
      permission: input.permission,
    });
  }
  if (isManagerApprover(input)) {
    return manager(input.levels === undefined ? {} : { levels: input.levels });
  }
  if (isAnyOfInput(input)) {
    if (!Array.isArray(input.of) || input.of.length === 0) {
      throw new Error("PermDock: anyOf() needs at least one approver");
    }
    // SAFETY: Array.isArray does not narrow a readonly array; the any-of form lists ApproverInput.
    const of = (input.of as readonly ApproverInput[]).map((item) => {
      const normalized = asApprover(item);
      const items = flattenApprovers(normalized);
      if (items.length === 0) {
        throw new Error("PermDock: an anyOf() item names no approver");
      }
      const [first] = items;
      return isReadonlyArray(normalized) || first === undefined ? items : first;
    });
    return Object.freeze({ kind: "any-of" as const, of: Object.freeze(of) });
  }
  if (isReadonlyArray(input)) {
    const items: Approver[] = [];
    // SAFETY: isReadonlyArray does not narrow the element type; the only array form is ApproverInput[].
    for (const item of input as readonly ApproverInput[]) {
      items.push(...flattenApprovers(asApprover(item)));
    }
    return items;
  }
  if (isUserApprover(input)) {
    return user(input.id);
  }
  // SAFETY: arrays and user approvers returned above, so input is a GranteeInput.
  return asGrantee(input as GranteeInput);
}

export function normalizeApproval(
  approval: ApprovalOption | undefined,
  permission?: string,
): Grant["approval"] {
  if (approval === undefined) {
    return undefined;
  }
  if (approval === "human") {
    return "human";
  }
  if (
    approval.staleOn !== undefined &&
    approval.staleOn !== "resource-change"
  ) {
    throw new Error(
      `PermDock: approval staleOn must be 'resource-change', got '${String(approval.staleOn)}'`,
    );
  }
  const label = permission ?? "a grant";
  assertQuorum(approval.quorum, "approval.quorum", label);
  if (approval.ttl !== undefined) {
    assertDuration(approval.ttl, `approval.ttl on '${label}'`);
  }
  const escalation = normalizeEscalation(approval.escalation, label);
  const mode = approvalMode(approval.mode, label);
  const fallback = approvalFallback(approval.fallback, label);
  const combine = approval.combine ?? "any";
  if (combine !== "any") {
    return compact<ApprovalRequirement>({
      combine,
      stages: normalizeStages(approval, combine, label),
      mode,
      fallback,
      staleOn: approval.staleOn,
      ttl: approval.ttl,
      escalation,
    });
  }
  if (approval.stages !== undefined) {
    throw new Error(
      `PermDock: approval.stages on '${label}' needs combine: 'all' or 'sequential'`,
    );
  }
  const by = approval.by === undefined ? undefined : asApprover(approval.by);
  if (
    by === undefined &&
    mode === undefined &&
    fallback === undefined &&
    approval.staleOn === undefined &&
    approval.quorum === undefined &&
    approval.ttl === undefined &&
    escalation === undefined
  ) {
    return "human";
  }
  return compact<ApprovalRequirement>({
    by: by ?? authenticated(),
    mode,
    fallback,
    staleOn: approval.staleOn,
    quorum: approval.quorum,
    ttl: approval.ttl,
    escalation,
  });
}

function assertQuorum(
  quorum: number | undefined,
  name: string,
  label: string,
): void {
  if (quorum !== undefined && (!Number.isInteger(quorum) || quorum < 1)) {
    throw new Error(
      `PermDock: ${name} on '${label}' must be an integer of at least 1, got ${String(quorum)}`,
    );
  }
}

const LEGACY_COMBINE: ReadonlySet<unknown> = new Set([
  "any",
  "all",
  "sequential",
]);

/**
 * An approval as a v1 record holds it. Records written before 0.17 carry the
 * combinator in `mode` and `distinct: false` for `'confirm'`; both read as the
 * current names.
 */
export function readWireApproval<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const mode: unknown = Reflect.get(value, "mode");
  const distinct: unknown = Reflect.get(value, "distinct");
  if (!LEGACY_COMBINE.has(mode) && typeof distinct !== "boolean") {
    return value;
  }
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== "mode" && !(key === "distinct" && typeof item === "boolean")) {
      next[key] = item;
    }
  }
  if (LEGACY_COMBINE.has(mode)) {
    next["combine"] = mode;
  } else if (mode !== undefined) {
    next["mode"] = mode;
  }
  if (distinct === false) {
    next["mode"] = "confirm";
  }
  // SAFETY: only the legacy keys were renamed; every other field of T is copied unchanged.
  return Object.freeze(next) as T;
}

/** `'authorize'` is the default, so it is stored as absent. */
function approvalMode(
  mode: ApprovalMode | undefined,
  label: string,
): "confirm" | undefined {
  if (mode === undefined || mode === "authorize") {
    return undefined;
  }
  if (mode !== "confirm") {
    throw new Error(
      `PermDock: approval.mode on '${label}' must be 'confirm' or 'authorize', got '${String(mode)}'`,
    );
  }
  return mode;
}

function approvalFallback(
  fallback: ApprovalFallback | undefined,
  label: string,
): "confirm" | undefined {
  if (fallback !== undefined && fallback !== "confirm") {
    throw new Error(
      `PermDock: approval.fallback on '${label}' must be 'confirm', got '${String(fallback)}'`,
    );
  }
  return fallback;
}

function normalizeStages(
  approval: Exclude<ApprovalOption, "human">,
  combine: ApprovalCombine,
  label: string,
): readonly ApprovalStage[] {
  if (combine !== "all" && combine !== "sequential") {
    throw new Error(
      `PermDock: approval.combine on '${label}' must be 'any', 'all' or 'sequential', got '${combine}'`,
    );
  }
  if (approval.by !== undefined || approval.quorum !== undefined) {
    throw new Error(
      `PermDock: approval on '${label}' sets combine '${combine}': put by and quorum on each stage`,
    );
  }
  const stages = approval.stages ?? [];
  if (stages.length === 0) {
    throw new Error(
      `PermDock: approval combine '${combine}' on '${label}' needs at least one stage`,
    );
  }
  return stages.map((stage, index) => {
    assertQuorum(stage.quorum, `approval.stages[${index}].quorum`, label);
    const by = asApprover(stage.by);
    if (flattenApprovers(by).length === 0) {
      throw new Error(
        `PermDock: approval.stages[${index}].by on '${label}' names no approver`,
      );
    }
    return compact<ApprovalStage>({
      by,
      quorum: stage.quorum,
      escalation: normalizeEscalation(stage.escalation, label),
    });
  });
}

function normalizeEscalation(
  escalation:
    | { readonly after: number; readonly to: ApproverInput }
    | undefined,
  label: string,
): ApprovalEscalation | undefined {
  if (escalation === undefined) {
    return undefined;
  }
  assertDuration(escalation.after, `approval.escalation.after on '${label}'`);
  return { after: escalation.after, to: asApprover(escalation.to) };
}

/**
 * A role with `activation` is eligible-only: it needs a positive `maxDuration`
 * (Doctor PD033 warns without one). `justification` defaults to `'optional'`.
 */
export function activationApproval(
  option: ApprovalOption | undefined,
  roleName: string,
): Grant["approval"] {
  const label = `activation of '${roleName}'`;
  const approval = normalizeApproval(option, label);
  if (
    approval !== undefined &&
    approval !== "human" &&
    approversOf(approval).some((item) => item.kind === "relation")
  ) {
    throw new Error(
      `PermDock: approval on ${label} names a relation; an activation has no row to read it on`,
    );
  }
  return approval;
}

/**
 * A stale-on-change approval needs a row to version: an instance permission
 * whose resource declares `version`.
 */
export function assertApprovalVersions(
  grants: readonly Grant[],
  resources: ReadonlyMap<string, ResourceNode>,
): void {
  for (const grant of grants) {
    const approval = grant.approval;
    if (
      approval === undefined ||
      approval === "human" ||
      approval.staleOn === undefined
    ) {
      continue;
    }
    if (grant.permission.kind !== "instance") {
      throw new Error(
        `PermDock: approval staleOn on '${grant.permission.key}' needs an instance action; a collection action has no row to version`,
      );
    }
    const node = resources.get(grant.permission.resource);
    if (node?.version === undefined) {
      throw new Error(
        `PermDock: approval staleOn on '${grant.permission.key}' needs resource(..., { version: '<field>' }) on '${grant.permission.resource}'`,
      );
    }
  }
}

/**
 * A relation approver is checked by id, from the requested row: the relation
 * lives on the permission's own resource (optionally up its parent chain), or
 * at the end of a list of links from it.
 */
export function assertApprovalRelations(
  grants: readonly Pick<Grant, "permission" | "approval">[],
  resources: ReadonlyMap<string, ResourceNode>,
): void {
  for (const grant of grants) {
    const approval = grant.approval;
    if (approval === undefined || approval === "human") {
      continue;
    }
    for (const item of approversOf(approval)) {
      if (item.kind !== "relation") {
        continue;
      }
      const label = `${grant.permission.key}: approver relation '${item.relation}'`;
      if (grant.permission.kind !== "instance") {
        throw new Error(
          `PermDock: ${label} needs an instance action; a collection action has no row to read it on`,
        );
      }
      const end = approverRelationResource(
        grant.permission.resource,
        item.through,
        resources,
      );
      if (end !== item.resource) {
        throw new Error(
          `PermDock: ${label} must live on '${grant.permission.resource}' or at the end of its through links`,
        );
      }
      if (
        resources.get(item.resource)?.relations[item.relation] === undefined
      ) {
        throw new Error(
          `PermDock: ${label} is not declared on '${item.resource}'`,
        );
      }
    }
  }
}

/**
 * The resource a relation approver's `through` reaches from `start`, or
 * `undefined`.
 */
function approverRelationResource(
  start: string,
  through: "parent" | readonly string[] | undefined,
  resources: ReadonlyMap<string, ResourceNode>,
): string | undefined {
  if (through === undefined) {
    return start;
  }
  if (through === "parent") {
    return isSelfParented(resources.get(start)) ? start : undefined;
  }
  let current: string | undefined = start;
  for (const name of through) {
    const node: ResourceNode | undefined =
      current === undefined ? undefined : resources.get(current);
    current =
      node !== undefined && Object.hasOwn(node.links, name)
        ? node.links[name]?.resource
        : undefined;
  }
  return current;
}
