import type { Policy } from "../core/policy.ts";
import type {
  OpenApiOverlayOptions,
  OpenApiPermDockOptions,
  OverlayOperation,
} from "./types.ts";

import { compact } from "../core/compact.ts";
import { listPermissions } from "../core/permissions.ts";
import { sha256 } from "../core/sha256.ts";
import {
  catalogOf,
  describeOf,
  securityProfileRequirementsOf,
  securitySchemesOf,
} from "./emit.ts";
import { DRAFT_PINS } from "./pins.ts";

function pointerEscape(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function actionKey(keys: readonly string[]): string {
  return keys.toSorted().join(",");
}

/** An RFC 9535 single-quoted string literal. */
function jsonPathString(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function operationTarget(operationId: string): string {
  return `$.paths.*[?@.operationId == ${jsonPathString(operationId)}]`;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** `sha256:` over the sorted permission keys and scopes, so the same catalog gives the same Overlay. */
function fingerprint(policy: Policy): string {
  const lines = listPermissions(policy.permissions)
    .map((leaf) => `${leaf.key} ${leaf.scope}`)
    .toSorted();
  return `sha256:${hex(sha256(lines.join("\n")))}`;
}

export function overlayOf(
  policy: Policy,
  options: OpenApiPermDockOptions,
  overlayOptions: OpenApiOverlayOptions = {},
): Record<string, unknown> {
  const version = overlayOptions.version ?? "1.1";
  const operations: readonly OverlayOperation[] = (
    overlayOptions.operations ??
    listPermissions(policy.permissions).map((leaf) => ({
      operationId: leaf.key,
      permissions: [leaf],
    }))
  ).toSorted((a, b) =>
    a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0,
  );
  const schemes = securitySchemesOf(policy, options);
  const requirements = securityProfileRequirementsOf(
    policy,
    options,
    overlayOptions.operations?.map((operation) =>
      operation.permissions.map((leaf) => leaf.scope),
    ),
  );
  const catalogPin = fingerprint(policy);
  const drafts =
    version === "1.2" ? { overlay: DRAFT_PINS.overlay } : undefined;
  const info = {
    title: "PermDock authorization metadata",
    version: catalogPin,
  };
  const head: Record<string, unknown>[] = [
    {
      target: "$.components.securitySchemes",
      description: "PermDock security schemes",
      update: schemes,
    },
  ];
  if (requirements !== undefined) {
    head.push({
      target: "$.components.securityProfileRequirements",
      description: "PermDock security profile requirements",
      update: requirements,
    });
  }
  const catalogAction = {
    target: "$",
    description: "PermDock catalog pin",
    update: {
      "x-permdock-catalog": catalogOf(options, drafts),
    },
  };
  const bodies = operations.map((operation) => {
    const keys = operation.permissions.map((leaf) => leaf.key);
    return {
      operationId: operation.operationId,
      key: actionKey(keys),
      target: operationTarget(operation.operationId),
      fields: describeOf(policy, options, operation.permissions),
    };
  });
  if (version === "1.1") {
    return compact({
      overlay: "1.1.0",
      info,
      extends: overlayOptions.extends,
      actions: [
        ...head,
        ...bodies.map((body) => ({
          target: body.target,
          description: body.key,
          update: body.fields,
        })),
        catalogAction,
      ],
    });
  }
  const reusable: Record<string, unknown> = {};
  for (const body of bodies.toSorted((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  )) {
    reusable[body.key] ??= {
      description: body.key,
      fields: { update: body.fields },
    };
  }
  return compact({
    overlay: "1.2.0",
    info,
    extends: overlayOptions.extends,
    components: { actions: reusable },
    actions: [
      ...head,
      ...bodies.map((body) => ({
        $ref: `#/components/actions/${pointerEscape(body.key)}`,
        target: body.target,
        description: body.operationId,
      })),
      catalogAction,
    ],
  });
}
