import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { Condition } from "../conditions/ast.ts";
import type { AppObligation } from "../core/decision.ts";
import type { Grantee } from "../core/grantee.ts";
import type { JsonSchemaNode } from "../core/json-schema.ts";
import type {
  ApprovalRequirement,
  BreakGlassSpec,
  Grant,
  GrantLimit,
  GrantMeta,
  Policy,
  WireValidity,
} from "../core/policy-types.ts";
import type { SnapshotScope } from "../core/snapshot-types.ts";

import { compact } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";
import { snapshotScopes } from "../core/instance-snapshot.ts";
import {
  checkSchema,
  copyJson,
  forbiddenKeyPath,
} from "../core/json-schema.ts";
import { RFC3339_PATTERN } from "../core/time.ts";
import { PermDockValidationError } from "../core/validation-error.ts";
import { wireValidity } from "../core/validity.ts";

/**
 * One code grant as `permdock cloud push` sends it. `portable: false` marks a
 * grant a snapshot cannot evaluate; `closure: true` marks one whose condition
 * is code, which `policyFromCatalog` turns into an allow that never matches
 * and a deny that always applies.
 */
export type PushedGrant = {
  readonly permission: string;
  readonly effect: "allow" | "deny";
  readonly role: string | null;
  readonly to: Grantee | readonly Grantee[];
  readonly where?: Condition;
  readonly check?: Condition;
  readonly approval?: "human" | ApprovalRequirement;
  /** A scope name or one resource; absent for a global grant. */
  readonly scope?: string | { readonly resource: string };
  readonly portable?: false;
  readonly closure?: true;
  readonly fields?: readonly string[];
  readonly limit?: GrantLimit;
  readonly validity?: WireValidity;
  readonly name?: string;
  readonly purpose?: readonly string[];
  readonly requires?: readonly string[];
  /** The membership kind (`via`) the grant applies under. */
  readonly viaOnly?: string;
  readonly breakGlass?: BreakGlassSpec;
  readonly obligations?: readonly AppObligation[];
  readonly meta?: GrantMeta;
};

/** PushedPolicy v1: the `policy` of a `permdock cloud push` body, validated by `schemas/pushed-policy-v1.json`. */
export type PushedPolicy = {
  readonly v: 1;
  /** The code policy's `fingerprint`. */
  readonly fingerprint: string;
  /** As a snapshot carries them; absent without declared scopes. */
  readonly scopes?: readonly SnapshotScope[];
  readonly grants: readonly PushedGrant[];
};

const strings = { type: "array", items: { type: "string" } } as const;
const instant = {
  type: "string",
  format: "date-time",
  pattern: RFC3339_PATTERN,
} as const;
const grantee = { type: "object", required: ["kind"] } as const;
const condition = { type: "object", required: ["op"] } as const;

/** `schemas/pushed-policy-v1.json`; a test keeps the two equal. */
export const PUSHED_POLICY_SCHEMA: JsonSchemaNode = freezeDeep({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://permdock.com/schemas/pushed-policy-v1.json",
  title: "PushedPolicy v1",
  type: "object",
  required: ["v", "fingerprint", "grants"],
  additionalProperties: false,
  properties: {
    v: { const: 1 },
    fingerprint: { type: "string", minLength: 1 },
    scopes: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "key"],
        properties: {
          name: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
          key: { type: "string" },
          within: { type: "string" },
          resources: strings,
          fields: { type: "object", additionalProperties: { type: "string" } },
        },
      },
    },
    grants: {
      type: "array",
      items: {
        type: "object",
        required: ["permission", "effect", "role", "to"],
        additionalProperties: false,
        properties: {
          permission: { type: "string", minLength: 1 },
          effect: { enum: ["allow", "deny"] },
          role: { type: ["string", "null"] },
          to: { oneOf: [grantee, { type: "array", items: grantee }] },
          where: condition,
          check: condition,
          approval: {
            oneOf: [{ const: "human" }, { type: "object" }],
          },
          scope: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                required: ["resource"],
                additionalProperties: false,
                properties: { resource: { type: "string" } },
              },
            ],
          },
          portable: { const: false },
          closure: { const: true },
          fields: strings,
          limit: {
            type: "object",
            required: ["count", "per"],
            properties: {
              count: { type: "integer", minimum: 0 },
              per: { type: "integer", minimum: 1 },
              mode: { enum: ["hard", "soft"] },
              alertAt: { type: "number" },
            },
          },
          validity: {
            type: "object",
            additionalProperties: false,
            properties: { from: instant, until: instant },
          },
          name: { type: "string" },
          purpose: strings,
          requires: strings,
          viaOnly: { type: "string" },
          breakGlass: {
            type: "object",
            required: ["overrides", "reason", "obligations"],
            properties: {
              overrides: strings,
              purpose: strings,
              reason: { type: "boolean" },
              assurance: { type: "object" },
              maxDuration: { type: "integer", minimum: 1 },
              obligations: {
                type: "array",
                items: { enum: ["notify", "review"] },
              },
            },
          },
          obligations: {
            type: "array",
            items: {
              type: "object",
              required: ["kind", "name"],
              properties: {
                kind: { const: "app" },
                name: { type: "string" },
              },
            },
          },
          meta: { type: "object" },
        },
      },
    },
  },
});

function pushedGrant(grant: Grant): PushedGrant {
  return compact<PushedGrant>({
    permission: grant.permission.key,
    effect: grant.effect,
    role: grant.role,
    to: grant.to,
    where: grant.where,
    check: grant.check,
    approval: grant.approval,
    scope:
      grant.scope === "global"
        ? undefined
        : typeof grant.scope === "string"
          ? grant.scope
          : { resource: grant.scope.resource },
    portable: grant.portable ? undefined : false,
    closure: grant.closure === undefined ? undefined : true,
    fields: grant.fields,
    limit: grant.limit,
    validity: wireValidity(grant.validity),
    name: grant.name,
    purpose: grant.purpose,
    requires: grant.requires,
    viaOnly: grant.viaOnly,
    breakGlass: grant.breakGlass,
    obligations: grant.obligations,
    meta:
      grant.meta === undefined || Object.keys(grant.meta).length === 0
        ? undefined
        : grant.meta,
  });
}

/** The code policy as `permdock cloud push` sends it; hosted grants are left out. */
export function pushedPolicy(policy: Policy): PushedPolicy {
  const scopes = snapshotScopes(policy);
  return {
    v: 1,
    fingerprint: policy.fingerprint,
    ...(scopes === undefined ? {} : { scopes }),
    grants: policy.grants
      .filter((grant) => grant.hosted === undefined)
      .map(pushedGrant),
  };
}

/**
 * Validates a pushed policy (parsed, or the JSON text) against
 * `schemas/pushed-policy-v1.json` and returns a deep-frozen copy. Throws
 * `PermDockValidationError`, also for a `__proto__`, `constructor` or
 * `prototype` key anywhere in it.
 */
export function parsePushedPolicy(json: unknown): PushedPolicy {
  const issues: StandardSchemaV1.Issue[] = [];
  let input = json;
  if (typeof json === "string") {
    try {
      input = JSON.parse(json);
    } catch {
      issues.push({ message: "Expected JSON text", path: [] });
    }
  }
  const copy =
    issues.length === 0 ? copyJson(input, [], issues, new Set()) : undefined;
  if (issues.length === 0) {
    checkSchema(PUSHED_POLICY_SCHEMA, copy, [], issues);
  }
  const unsafe = issues.length === 0 ? forbiddenKeyPath(copy) : undefined;
  if (unsafe !== undefined) {
    issues.push({ message: "Unsafe key", path: [...unsafe] });
  }
  const [first] = issues;
  if (first !== undefined) {
    const where =
      first.path === undefined || first.path.length === 0
        ? ""
        : ` at ${first.path.map(String).join(".")}`;
    throw new PermDockValidationError({
      code: "invalid-data",
      permission: "",
      resource: "",
      boundary: "pushed-policy",
      issues,
      message: `PermDock: invalid pushed policy${where}: ${first.message}`,
    });
  }
  // SAFETY: copy is plain JSON that passed PUSHED_POLICY_SCHEMA, the schema PushedPolicy describes.
  return freezeDeep(copy as PushedPolicy);
}
