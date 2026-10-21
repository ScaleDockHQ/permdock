import type { Preset } from "./catalog.ts";

import { DOMAINS } from "./domain.ts";
import { grantShape } from "./generate.ts";

/** How one role reaches one action under a preset. */
export type MatrixAccess = {
  /**
   * `allow`: always; `own`: on rows it owns; `pro`: on the pro plan; `none`:
   * never.
   */
  readonly access: "allow" | "own" | "pro" | "none";
  readonly approval: boolean;
  readonly limit: boolean;
};

export type PresetMatrix = {
  readonly roles: readonly string[];
  readonly rows: readonly {
    readonly resource: string;
    readonly action: string;
    readonly cells: Readonly<Record<string, MatrixAccess>>;
  }[];
};

const NONE: MatrixAccess = { access: "none", approval: false, limit: false };

/**
 * Who may do what under `preset`, from the same model the generated policy is
 * written from, for a page that shows the policy without running it.
 */
export function presetMatrix(preset: Preset): PresetMatrix {
  const domain = DOMAINS[preset.archetype];
  const plans = preset.features.includes("plans") && domain.pro !== undefined;
  const actions = domain.resources.flatMap((resource) => {
    const base =
      resource.preset === "crud"
        ? ["read", "list", "create", "update", "delete"]
        : ["read", "list"];
    return [
      ...base,
      ...(resource.actions ?? []),
      ...(resource.collection ?? []),
    ].map((action) => ({ resource: resource.name, action }));
  });
  const rows = actions.map(({ resource, action }) => {
    const cells: Record<string, MatrixAccess> = {};
    const isPro =
      plans &&
      domain.pro?.resource === resource &&
      domain.pro.action === action;
    for (const role of domain.roles) {
      const grant = role.grants.find(
        (item) => item.resource === resource && item.action === action,
      );
      if (grant === undefined || (isPro && role.top !== true)) {
        cells[role.name] = isPro ? { ...NONE, access: "pro" } : NONE;
        continue;
      }
      const shape = grantShape(preset, role, grant);
      cells[role.name] = {
        access: shape.owner === undefined ? "allow" : "own",
        approval: shape.approval,
        limit: shape.limit,
      };
    }
    return { resource, action, cells };
  });
  return { roles: domain.roles.map((role) => role.name), rows };
}
