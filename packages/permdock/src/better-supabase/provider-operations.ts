import type { AuthorizationOperation } from "better-supabase/contract";

import type { CatalogApproval, CatalogDocument } from "../catalog/types.ts";
import type { OperationRisk } from "../core/operation-risks.ts";
import type { OperationEffect } from "../core/operations.ts";
import type { BlockApprovalApprovers } from "./approvals-block.ts";

import { isRecord } from "../core/compact.ts";

type AuthorizationApproval = NonNullable<AuthorizationOperation["approval"]>;

const RISKS: Readonly<
  Record<
    OperationRisk,
    NonNullable<NonNullable<AuthorizationOperation["meta"]>["risk"]>
  >
> = { low: "low", medium: "medium", high: "high", critical: "high" };

const EFFECTS: Readonly<
  Record<
    OperationEffect,
    NonNullable<NonNullable<AuthorizationOperation["meta"]>["effects"]>[number]
  >
> = {
  read: "read",
  write: "write",
  delete: "delete",
  send: "external",
  spend: "external",
  external: "external",
};

type Approvers = {
  -readonly [K in keyof BlockApprovalApprovers]: BlockApprovalApprovers[K];
};

/**
 * One approver of a catalog `by` into the block's step approvers. Only one
 * permission and one role fit a step; a second, an `allOf` list, a relation or
 * a manager chain longer than one level does not.
 */
function addApprover(
  into: Approvers,
  approver: unknown,
  tenantScope: string,
): boolean {
  if (!isRecord(approver)) return false;
  const kind = approver["kind"];
  if (kind === "user" && typeof approver["id"] === "string") {
    into.users = [...(into.users ?? []), approver["id"]];
    return true;
  }
  if (
    kind === "permission" &&
    typeof approver["permission"] === "string" &&
    into.permission === undefined
  ) {
    into.permission = approver["permission"];
    return true;
  }
  if (
    kind === "role" &&
    typeof approver["role"] === "string" &&
    approver["scope"] === tenantScope &&
    into.role === undefined
  ) {
    into.role = approver["role"];
    return true;
  }
  if (
    kind === "manager" &&
    (approver["levels"] === undefined || approver["levels"] === 1)
  ) {
    into.manager = true;
    return true;
  }
  return false;
}

function approversOf(
  by: unknown,
  tenantScope: string,
): BlockApprovalApprovers | undefined {
  const into: Approvers = {};
  const items =
    isRecord(by) && by["kind"] === "any-of" && Array.isArray(by["of"])
      ? by["of"]
      : [by];
  for (const item of items) {
    const single: unknown =
      Array.isArray(item) && item.length === 1 ? item[0] : item;
    if (!addApprover(into, single, tenantScope)) return undefined;
  }
  return into;
}

/**
 * A catalog approval as the approvals block's floor: `by` is one step, and
 * `stages` one step each, in order when `combine` is `sequential`. `quorum`
 * becomes `required`. `ttl`, `escalation`, `staleOn` and `mode` have no
 * counterpart and are left out, which never lowers the floor.
 */
function approvalOf(
  approval: CatalogApproval,
  tenantScope: string,
): AuthorizationApproval | undefined {
  if (approval === "human") return undefined;
  const stages =
    approval.stages ??
    (approval.by === undefined
      ? []
      : [{ by: approval.by, quorum: approval.quorum }]);
  if (stages.length === 0) return undefined;
  const steps: Readonly<Record<string, unknown>>[] = [];
  for (const stage of stages) {
    const approvers = approversOf(stage.by, tenantScope);
    if (approvers === undefined) return undefined;
    steps.push({ approvers, required: stage.quorum ?? 1 });
  }
  return {
    steps,
    ...(steps.length > 1
      ? {
          mode:
            approval.combine === "sequential"
              ? ("sequential" as const)
              : ("parallel" as const),
        }
      : {}),
  };
}

/**
 * The catalog's `defineOperations` entries as better-supabase operations. A
 * name with a `.` is used as written (`workflow.node.http`); any other is the
 * tool `ai.tool.<name>` and `mcp.tool.<name>`. `critical` risk is `high`, and
 * `send` and `spend` effects are `external`. A permission whose code allows
 * require an approval adds `<resource>:<action>` with that approval as its
 * floor; one with several different approvals, or an approver the block cannot
 * express, is named in `problems` and has no floor.
 */
export function operationsOf(
  catalog: CatalogDocument,
  tenantScope: string,
  problems: string[],
): Record<string, AuthorizationOperation> {
  const operations: Record<string, AuthorizationOperation> = {};
  for (const operation of catalog.operations ?? []) {
    const effects = [
      ...new Set(
        (operation.meta.effects ?? []).map((effect) => EFFECTS[effect]),
      ),
    ];
    const meta = {
      ...(operation.meta.risk === undefined
        ? {}
        : { risk: RISKS[operation.meta.risk] }),
      ...(effects.length > 0 ? { effects } : {}),
      ...(operation.meta.title === undefined
        ? {}
        : { title: operation.meta.title }),
    };
    const entry: AuthorizationOperation = {
      permission: operation.permission,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    };
    const names = operation.name.includes(".")
      ? [operation.name]
      : [`ai.tool.${operation.name}`, `mcp.tool.${operation.name}`];
    for (const name of names) operations[name] = entry;
  }
  for (const permission of catalog.permissions) {
    const approvals = permission.approvals ?? [];
    const [only] = approvals;
    if (only === undefined) continue;
    const approval =
      approvals.length === 1 ? approvalOf(only, tenantScope) : undefined;
    if (approval === undefined) {
      if (only !== "human" || approvals.length > 1) {
        problems.push(
          `operations: ${permission.key} requires ${approvals.length > 1 ? "several different approvals" : "an approval whose approvers the approvals block cannot express"}, so ${permission.resource}:${permission.action} has no approval floor.`,
        );
      }
      continue;
    }
    operations[`${permission.resource}:${permission.action}`] = {
      permission: permission.key,
      approval,
    };
  }
  return operations;
}
