import { testAuthorizationHooks } from "better-supabase/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { Principal } from "../../src/index.ts";

import {
  type AuthorizationHooksOptions,
  authorizationHooks,
} from "../../src/better-supabase/index.ts";
import { holder, user } from "../../src/core/approvers.ts";
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
const EDITOR = "22222222-2222-4222-8222-222222222222";
const VIEWER = "44444444-4444-4444-8444-444444444444";
const LEAD = "55555555-5555-4555-8555-555555555555";

const Doc = z.object({ id: z.string(), organization_id: z.string() });
const permissions = definePermissions({
  doc: resource(Doc, {
    id: "id",
    actions: ["read", "update", "approve"],
    relations: {
      organization: { field: "organization_id", memberOf: "organization" },
    },
  }),
});
const { doc } = permissions;

const roles = defineRoles({
  editor: { on: "organization" },
  viewer: { on: "organization" },
  lead: { on: "organization" },
});
const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { organization: { key: "organization_id" } },
    // SAFETY: the hooks always pass a Subject, which this resolver returns unchanged.
    subject: (subject: unknown) => subject as never,
    roles: [
      role(roles.editor, [allow([doc.read, doc.update])], {
        on: "organization",
      }),
      role(roles.viewer, [allow(doc.read)], { on: "organization" }),
      role(roles.lead, [allow([doc.read, doc.approve])], {
        on: "organization",
      }),
    ],
  },
);

const claimsFor = (sub: string, roleName: string, tenant = ORG) => ({
  sub,
  role: "authenticated",
  tenant_id: tenant,
  memberships: [{ scope: "organization", id: tenant, roles: [roleName] }],
});
const users: Record<string, ReturnType<typeof claimsFor>> = {
  [EDITOR]: claimsFor(EDITOR, "editor"),
  [VIEWER]: claimsFor(VIEWER, "viewer"),
  [LEAD]: claimsFor(LEAD, "lead"),
};

const principal = (id: string, kind: "user" | "contact"): Principal => ({
  id,
  kind,
  tenant: ORG,
  memberships: [{ scope: "organization", id: ORG, roles: ["viewer"] }],
});

const base: AuthorizationHooksOptions = {
  policy,
  claims: (userId) => users[userId] ?? null,
};
const hooks = authorizationHooks({
  ...base,
  service: (tenant) =>
    tenant === ORG ? claimsFor("service-account", "editor") : null,
  principals: memoryPrincipalSource({
    principals: [principal(VIEWER, "user"), principal("c1", "contact")],
    identities: [
      {
        identity: { kind: "email", value: "viewer@example.com" },
        principal: VIEWER,
      },
      {
        identity: { kind: "email", value: "client@example.com" },
        principal: "c1",
      },
    ],
  }),
  events: { "doc.updated": doc.read },
  approvers: { tool: holder(doc.approve), deploy: user(EDITOR) },
  support: {},
  tickets: (ticket) =>
    ticket === "t-editor"
      ? { userId: EDITOR, tenant: ORG }
      : ticket === "t-gone"
        ? { userId: "deleted-user" }
        : null,
});
const automation = hooks.automation!;

describe("authorizationHooks", () => {
  it("passes better-supabase's conformance kit with every hook set", async () => {
    await expect(testAuthorizationHooks(hooks)).resolves.toBeDefined();
    await expect(
      testAuthorizationHooks(authorizationHooks(base)),
    ).resolves.toBeDefined();
    expect(authorizationHooks(base)).not.toHaveProperty("approverOf");
    expect(authorizationHooks(base)).not.toHaveProperty("delivery");
  });

  describe("automation", () => {
    const ref = {
      publisher: EDITOR,
      tenant: ORG,
      permissions: [doc.read.key, doc.update.key],
      claims: users[EDITOR]!,
    };

    it("lets a publisher publish only keys they hold in the tenant", async () => {
      expect(await automation.mayPublish!(ref)).toBe(true);
      expect(
        await automation.mayPublish!({ ...ref, claims: users[VIEWER]! }),
      ).toBe(false);
      expect(await automation.mayPublish!({ ...ref, tenant: OTHER })).toBe(
        false,
      );
      expect(
        await automation.mayPublish!({ ...ref, permissions: ["doc.unknown"] }),
      ).toBe(false);
      expect(await automation.mayPublish!({ ...ref, publisher: null })).toBe(
        false,
      );
    });

    it("runs as the publisher's current claims capped to the automation's keys", async () => {
      const { claims: _claims, ...run } = ref;
      expect(await automation.runAs!(run)).toEqual({
        ...users[EDITOR],
        bs_permission_cap: [doc.read.key, doc.update.key],
      });
      expect(await automation.runAs!({ ...run, publisher: VIEWER })).toBeNull();
      expect(
        await automation.runAs!({ ...run, publisher: "deleted-user" }),
      ).toBeNull();
    });

    it("runs an organization-owned automation as the service claims, or as no one", async () => {
      const run = { publisher: null, tenant: ORG, permissions: [doc.read.key] };
      expect(await automation.runAs!(run)).toMatchObject({
        sub: "service-account",
        bs_permission_cap: [doc.read.key],
      });
      expect(await authorizationHooks(base).automation!.runAs!(run)).toBeNull();
    });

    it("refuses claims whose sub is not the publisher", async () => {
      const forged = authorizationHooks({
        policy,
        claims: () => users[EDITOR]!,
      });
      expect(
        await forged.automation!.runAs!({
          publisher: VIEWER,
          tenant: ORG,
          permissions: [doc.read.key],
        }),
      ).toBeNull();
    });
  });

  it("maps delegated scopes to the keys whose scope they are", async () => {
    expect(
      await hooks.delegation!.permissions({
        userId: EDITOR,
        tenant: ORG,
        clientId: "c",
        scopes: [doc.read.scope, "unmapped:scope"],
      }),
    ).toEqual([doc.read.key]);
  });

  describe("approverOf", () => {
    const request = {
      kind: "tool",
      subject: "s1",
      tenant: ORG,
      requester: EDITOR,
    };
    const as = (userId: string) => ({ userId, claims: users[userId]! });

    it("lets a holder of the approver permission approve, never the requester", async () => {
      expect(await hooks.approverOf!(as(LEAD), request)).toBe(true);
      expect(await hooks.approverOf!(as(VIEWER), request)).toBe(false);
      expect(
        await hooks.approverOf!(as(LEAD), { ...request, requester: LEAD }),
      ).toBe(false);
      expect(
        await hooks.approverOf!(as(LEAD), { ...request, tenant: OTHER }),
      ).toBe(false);
    });

    it("matches a user approver by id and refuses an unknown kind or forged claims", async () => {
      const deploy = { ...request, kind: "deploy", requester: VIEWER };
      expect(await hooks.approverOf!(as(EDITOR), deploy)).toBe(true);
      expect(await hooks.approverOf!(as(LEAD), deploy)).toBe(false);
      expect(
        await hooks.approverOf!(as(LEAD), { ...request, kind: "toString" }),
      ).toBe(false);
      expect(
        await hooks.approverOf!(
          { userId: LEAD, claims: users[EDITOR]! },
          request,
        ),
      ).toBe(false);
    });
  });

  it("maps a linked identity to a user or a contact", async () => {
    const { identities } = hooks;
    expect(
      await identities!.principalByIdentity({
        kind: "email",
        value: "viewer@example.com",
      }),
    ).toEqual({ kind: "user", userId: VIEWER });
    expect(
      await identities!.principalByIdentity({
        kind: "email",
        value: "client@example.com",
      }),
    ).toEqual({ kind: "contact", contactId: "c1" });
  });

  it("resolves a ticket to the user's current claims, or null", async () => {
    expect(await hooks.tickets!.subject("t-editor")).toEqual({
      claims: users[EDITOR],
      tenant: ORG,
    });
    expect(await hooks.tickets!.subject("t-gone")).toBeNull();
    expect(await hooks.tickets!.subject("t-unknown")).toBeNull();
  });
});
