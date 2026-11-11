import { describe, expect, it } from "vitest";

import type { Snapshot } from "../../src/index.ts";

import { delegatedScopeMap } from "../../src/core/oauth-scopes.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  fromSnapshot,
  getPermDockSync,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  organization: resource({
    actions: { read: {}, transferOwnership: { interactiveOnly: true } },
  }),
});
const { organization } = permissions;

type User = { readonly id: string; readonly roles: readonly string[] };

const policy = definePolicy(permissions, {
  roles: [
    role("owner", [allow([organization.read, organization.transferOwnership])]),
  ],
  delegations: [{ from: "owner", to: "agent", permissions: [organization] }],
  subject: (user: User) => user,
});

const owner: User = { id: "u1", roles: ["owner"] };

function reason(
  permdock: ReturnType<typeof getPermDockSync>,
  permission: typeof organization.read | typeof organization.transferOwnership,
): string | undefined {
  const decision = permdock.decide(permission, {});
  return decision.outcome === "denied"
    ? decision.denials[0]?.reason
    : decision.outcome;
}

function unsigned(permdock: ReturnType<typeof getPermDockSync>): Snapshot {
  const snapshot = permdock.snapshot();
  if (snapshot instanceof Promise) {
    throw new TypeError("unsigned snapshot expected");
  }
  return snapshot;
}

describe("meta.interactiveOnly", () => {
  it("grants the user's own session", () => {
    const permdock = getPermDockSync(policy, owner);
    expect(reason(permdock, organization.transferOwnership)).toBe("granted");
    expect(permdock.mayUse(organization.transferOwnership)).toBe(true);
  });

  it.each([
    ["an agent", { actor: { id: "agent-1", kind: "agent" } }],
    [
      "an OAuth client",
      {
        actor: { id: "cli", kind: "oauth-client" },
        delegation: {
          scopes: ["organization:read", "organization:transferOwnership"],
        },
      },
    ],
    [
      "a scoped token",
      {
        delegation: {
          scopes: ["organization:read", "organization:transferOwnership"],
        },
      },
    ],
  ] as const)("refuses %s whatever its scopes or delegations", (_, extra) => {
    const permdock = getPermDockSync(policy, owner, extra);
    expect(reason(permdock, organization.read)).toBe("granted");
    expect(reason(permdock, organization.transferOwnership)).toBe(
      "not-delegated",
    );
    expect(permdock.mayUse(organization.transferOwnership)).toBe(false);
    const client = fromSnapshot(unsigned(permdock));
    expect(client.can(organization.read, {})).toBe(true);
    expect(client.can(organization.transferOwnership, {})).toBe(false);
  });

  it("maps no OAuth scope to an interactive-only key", () => {
    expect(
      delegatedScopeMap(
        [
          { key: "organization.read", scope: "organization:read" },
          {
            key: "organization.transferOwnership",
            scope: "organization:transferOwnership",
            meta: { interactiveOnly: true },
          },
        ],
        [
          {
            scope: "admin",
            permissions: [
              "organization.read",
              "organization.transferOwnership",
            ],
          },
        ],
      ),
    ).toStrictEqual({
      admin: ["organization.read"],
      "organization:read": ["organization.read"],
    });
  });
});
