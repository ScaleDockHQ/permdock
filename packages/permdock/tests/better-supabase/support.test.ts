import type { SupportAuthorizeInput } from "better-supabase/server";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  type SupportPolicyOptions,
  supportPolicy,
} from "../../src/better-supabase/index.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  resource,
  role,
} from "../../src/index.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const TARGET = "44444444-4444-4444-8444-444444444444";
const APPROVER = "55555555-5555-4555-8555-555555555555";

const Ticket = z.object({ id: z.string(), organization_id: z.string() });

const permissions = definePermissions({
  ticket: resource(Ticket, {
    id: "id",
    actions: ["read", "update", "delete"],
    relations: {
      organization: { field: "organization_id", memberOf: "organization" },
    },
  }),
});
const { ticket } = permissions;

const roles = defineRoles({ support: { on: "organization" } });
const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { organization: { key: "organization_id" } },
    // SAFETY: supportPolicy always passes a Subject, which this resolver returns unchanged.
    subject: (user: unknown) => user as never,
    roles: [
      role(roles.support, [allow([ticket.read, ticket.update])], {
        on: "organization",
      }),
    ],
  },
);

const input = (
  overrides: Partial<Omit<SupportAuthorizeInput, "admin">> & {
    claims?: Record<string, unknown>;
  } = {},
): SupportAuthorizeInput => {
  const { claims, ...rest } = overrides;
  const all = {
    sub: ADMIN,
    role: "authenticated",
    tenant_id: ORG,
    memberships: [{ scope: "organization", id: ORG, roles: ["support"] }],
    ...claims,
  };
  return {
    // SAFETY: the authorize hook reads only kind, user.id and claims of the admin.
    admin: {
      kind: "user",
      token: "t",
      claims: all,
      user: { id: all.sub },
      source: "cookie",
      expiresAt: null,
    } as unknown as SupportAuthorizeInput["admin"],
    targetUserId: TARGET,
    reason: "Ticket 4512: invoice totals look wrong",
    readOnly: true,
    tenant: ORG,
    metadata: {},
    ...rest,
  };
};

describe("supportPolicy", () => {
  it("waits for a distinct approver by default", async () => {
    expect(await supportPolicy({ policy })(input())).toBe(false);
    const approved = vi.fn<NonNullable<SupportPolicyOptions["approved"]>>(
      () => ({ approvedBy: APPROVER }),
    );
    const authorize = supportPolicy({ policy, approved });
    expect(await authorize(input())).toBe(true);
    expect(approved).toHaveBeenCalledWith(
      input(),
      expect.objectContaining({
        token: expect.stringMatching(/^sha-256:/u),
        session: expect.objectContaining({
          principal: TARGET,
          actor: ADMIN,
          tenant: ORG,
          permissions: [ticket.read.key],
        }),
      }),
    );
  });

  it("refuses the admin approving their own session", async () => {
    const authorize = supportPolicy({
      policy,
      approved: () => ({ approvedBy: ADMIN }),
    });
    expect(await authorize(input())).toBe(false);
  });

  it("gives the same token for the same start", async () => {
    const tokens: string[] = [];
    const authorize = supportPolicy({
      policy,
      approved: (_input, pending) => {
        tokens.push(pending.token);
        return undefined;
      },
    });
    await authorize(input());
    await authorize(input());
    await authorize(input({ reason: "Another ticket" }));
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[2]).not.toBe(tokens[0]);
  });

  it("starts a read-only session without approval when approval is off", async () => {
    const authorize = supportPolicy({ policy, approval: false });
    expect(await authorize(input())).toBe(true);
    expect(await authorize(input({ reason: "  " }))).toBe(false);
    expect(await authorize(input({ tenant: OTHER }))).toBe(false);
    expect(await authorize(input({ targetUserId: ADMIN }))).toBe(false);
  });

  it("refuses a writable session unless writable lists what it may write", async () => {
    expect(
      await supportPolicy({ policy, approval: false })(
        input({ readOnly: false }),
      ),
    ).toBe(false);
    const authorize = supportPolicy({
      policy,
      approval: false,
      writable: [ticket.read, ticket.update],
    });
    expect(await authorize(input({ readOnly: false }))).toBe(true);
    expect(
      await supportPolicy({
        policy,
        approval: false,
        writable: [ticket.delete],
      })(input({ readOnly: false })),
    ).toBe(false);
  });

  it("refuses an impersonated admin, a mismatched user and a throwing callback", async () => {
    const authorize = supportPolicy({ policy, approval: false });
    expect(
      await authorize(
        input({ claims: { act: { sub: APPROVER, kind: "support" } } }),
      ),
    ).toBe(false);
    const mismatched = input();
    expect(
      await authorize({
        ...mismatched,
        admin: {
          ...mismatched.admin,
          user: { ...mismatched.admin.user, id: APPROVER },
        },
      }),
    ).toBe(false);
    const throwing = supportPolicy({
      policy,
      approved: () => {
        throw new Error("store down");
      },
    });
    expect(await throwing(input())).toBe(false);
  });
});
