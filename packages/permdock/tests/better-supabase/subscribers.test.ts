import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { Principal } from "../../src/index.ts";

import { subscriberPolicy } from "../../src/better-supabase/index.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  memoryPrincipalSource,
  resource,
  role,
} from "../../src/index.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";

const Invoice = z.object({ id: z.string(), organization_id: z.string() });
const Member = z.object({ id: z.string(), organization_id: z.string() });

const permissions = definePermissions({
  invoice: resource(Invoice, {
    id: "id",
    actions: ["read"],
    relations: {
      organization: { field: "organization_id", memberOf: "organization" },
    },
  }),
  member: resource(Member, {
    id: "id",
    actions: ["read"],
    relations: {
      organization: { field: "organization_id", memberOf: "organization" },
    },
  }),
});

const roles = defineRoles({
  billing: { on: "organization" },
  viewer: { on: "organization" },
});
const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { organization: { key: "organization_id" } },
    // SAFETY: subscriberPolicy always passes a Subject, which this resolver returns unchanged.
    subject: (user: unknown) => user as never,
    roles: [
      role(roles.billing, [allow(permissions.invoice.read)], {
        on: "organization",
      }),
      role(roles.viewer, [allow(permissions.member.read)], {
        on: "organization",
      }),
    ],
  },
);

const user = (id: string, roleName: string, tenant = ORG): Principal => ({
  id,
  kind: "user",
  tenant,
  memberships: [{ scope: "organization", id: tenant, roles: [roleName] }],
});
const principals = memoryPrincipalSource({
  principals: [
    user("actor", "viewer"),
    user("billing", "billing"),
    user("viewer", "viewer"),
    user("outsider", "billing", OTHER),
    { ...user("integration", "viewer"), kind: "service" },
  ],
});

const subscribers = [
  { endpoint: "e1", principal: "billing" },
  { endpoint: "e2", principal: "viewer" },
  { endpoint: "e3", principal: "outsider" },
  { endpoint: "e4", principal: "missing" },
];

const event = (overrides: Record<string, unknown> = {}) => ({
  type: "invoice.paid",
  tenant: ORG,
  actorId: "actor",
  payload: { id: "inv_1", organization_id: ORG },
  ...overrides,
});

describe("subscriberPolicy", () => {
  const filter = subscriberPolicy({
    policy,
    principals,
    events: {
      "invoice.*": permissions.invoice.read,
      "member.joined": permissions.member.read,
    },
  });

  it("keeps the subscribers whose principal may read the event's row", async () => {
    expect(await filter(event(), subscribers)).toEqual([subscribers[0]]);
    expect(
      await filter(
        event({
          type: "member.joined",
          payload: { id: "m_1", organization_id: ORG },
        }),
        subscribers,
      ),
    ).toEqual([subscribers[1]]);
  });

  it("delivers an unmapped type, a row from another tenant or a bad payload to no one", async () => {
    expect(await filter(event({ type: "invoice" }), subscribers)).toEqual([]);
    expect(await filter(event({ type: "team.created" }), subscribers)).toEqual(
      [],
    );
    expect(
      await filter(
        event({ payload: { id: "inv_2", organization_id: OTHER } }),
        subscribers,
      ),
    ).toEqual([]);
    expect(await filter(event({ payload: { id: 1 } }), subscribers)).toEqual(
      [],
    );
  });

  it("needs a tenant and a sender principal in it", async () => {
    expect(await filter(event({ tenant: null }), subscribers)).toEqual([]);
    expect(await filter(event({ actorId: null }), subscribers)).toEqual([]);
    expect(await filter(event({ actorId: "outsider" }), subscribers)).toEqual(
      [],
    );
    const viaService = subscriberPolicy({
      policy,
      principals,
      events: { "invoice.paid": permissions.invoice.read },
      sender: () => "integration",
    });
    expect(await viaService(event({ actorId: null }), subscribers)).toEqual([
      subscribers[0],
    ]);
  });

  it("prefers an exact type over a pattern and reads the row option", async () => {
    const exact = subscriberPolicy({
      policy,
      principals,
      events: {
        "*": permissions.invoice.read,
        "invoice.paid": permissions.member.read,
      },
      row: (input) => input.payload,
    });
    expect(await exact(event(), subscribers)).toEqual([subscribers[1]]);
    expect(await exact(event({ type: "other" }), subscribers)).toEqual([
      subscribers[0],
    ]);
  });

  it("delivers to no one when the principal source throws", async () => {
    const failing = subscriberPolicy({
      policy,
      principals: {
        principal: () => {
          throw new Error("db down");
        },
      },
      events: { "*": permissions.invoice.read },
    });
    expect(await failing(event(), subscribers)).toEqual([]);
  });
});
