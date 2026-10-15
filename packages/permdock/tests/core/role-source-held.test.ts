import { describe, expect, it } from "vitest";

import type { CustomRoleSource } from "../../src/core/interfaces.ts";
import type { CustomRole, Principal } from "../../src/index.ts";

import { memoryCustomRoleSource } from "../../src/core/memory-sources.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import {
  assets,
  customRoles,
  permissions,
  personas,
  policy,
} from "../fixtures/named-scopes.ts";

function recording(source: CustomRoleSource): {
  readonly source: CustomRoleSource;
  readonly calls: [string, readonly string[] | undefined][];
} {
  const calls: [string, readonly string[] | undefined][] = [];
  return {
    calls,
    source: {
      rolesFor(tenant, context) {
        calls.push([tenant, context?.held]);
        return source.rolesFor(tenant, context);
      },
    },
  };
}

describe("CustomRoleSource.rolesFor receives the held role names", () => {
  it("passes each tenant's live membership roles, nested scopes included", async () => {
    const { source, calls } = recording(memoryCustomRoleSource(customRoles));
    const principal: Principal = {
      ...personas.staffContact,
      memberships: [
        ...(personas.staffContact.memberships ?? []),
        {
          scope: "organization",
          id: "B",
          roles: ["admin"],
          via: "staff",
          expiresAt: 1,
        },
      ],
    };
    createPermDock(policy, principal, { customRoles: source });
    expect(calls).toEqual([
      ["T", ["member"]],
      ["B", ["contact"]],
    ]);
  });

  it("lets a source skip its read when every held role is declared", async () => {
    const declared = new Set(policy.rolesByName.keys());
    const reads: string[] = [];
    const source: CustomRoleSource = {
      rolesFor(tenant, context): CustomRole[] {
        if (context?.held.every((name) => declared.has(name)) === true) {
          return [];
        }
        reads.push(tenant);
        return customRoles.filter((role) => role.tenant === tenant);
      },
    };
    const admin = createPermDock(policy, personas.admin, {
      customRoles: source,
    });
    expect(admin.can(permissions.asset.delete, assets[0]!)).toBe(true);
    const mechanic = createPermDock(policy, personas.mechanic, {
      customRoles: source,
    });
    expect(reads).toEqual(["T"]);
    expect(mechanic.can(permissions.asset.update, assets[0]!)).toBe(true);
    expect(mechanic.can(permissions.asset.delete, assets[0]!)).toBe(false);
  });
});
