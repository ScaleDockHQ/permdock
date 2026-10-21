import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AppData } from "../../src/index.ts";

import {
  allow,
  getPermDockSync,
  definePermissions,
  definePolicy,
  defineRoles,
  definePlans,
  deny,
  fromSnapshot,
  getResource,
  memoryCustomRoleSource,
  parseSnapshot,
  resource,
  role,
} from "../../src/index.ts";

const Risk = z.object({ risk: z.enum(["low", "high"]) });

describe("permission and resource x", () => {
  it("checks every action x against the permission schema and keeps the output", () => {
    const tree = definePermissions(
      {
        invoice: resource({
          actions: { send: { x: { risk: "high" } }, read: {} },
          meta: { title: "Invoice", x: { owner: "billing" } },
        }),
      },
      { x: { permission: Risk, resource: z.object({ owner: z.string() }) } },
    );
    expect(tree.invoice.send.meta.x).toEqual({ risk: "high" });
    expect(tree.invoice.read.meta).toEqual({});
    const node = getResource(tree, "invoice");
    expect(node?.meta).toEqual({ title: "Invoice", x: { owner: "billing" } });
    expect(Object.isFrozen(node?.meta)).toBe(true);
  });

  it("throws at definition time on x that fails its schema", () => {
    expect(() =>
      definePermissions(
        { invoice: resource({ actions: { send: { x: { risk: "mid" } } } }) },
        { x: { permission: Risk } },
      ),
    ).toThrow(/meta.x of action 'send' is invalid/u);
    expect(() =>
      definePermissions(
        { invoice: resource({ actions: ["send"], meta: { x: { owner: 1 } } }) },
        { x: { resource: z.object({ owner: z.string() }) } },
      ),
    ).toThrow(/meta.x of resource 'invoice' is invalid/u);
  });

  it("refuses an async schema", () => {
    const asyncSchema = z.object({ risk: z.string() }).refine(async () => true);
    expect(() =>
      definePermissions(
        { invoice: resource({ actions: { send: { x: { risk: "high" } } } }) },
        { x: { permission: asyncSchema } },
      ),
    ).toThrow(/synchronously/u);
  });

  it("rejects resource meta that is not plain JSON or has a non-string title", () => {
    expect(() =>
      definePermissions({
        doc: resource({
          actions: ["read"],
          // SAFETY: a wrong type, as a JavaScript caller could pass it.
          meta: { title: 1 as never },
        }),
      }),
    ).toThrow(/meta.title of resource 'doc' must be a string/u);
  });
});

describe("role and plan x", () => {
  it("validates role meta as JSON and x against the schema", () => {
    const roles = defineRoles(
      { admin: { meta: { title: "Admin", x: { tier: 2 } } } },
      { x: z.object({ tier: z.number() }) },
    );
    expect(roles.admin.meta).toEqual({ title: "Admin", x: { tier: 2 } });
    expect(() =>
      defineRoles(
        { admin: { meta: { x: { tier: "two" } } } },
        { x: z.object({ tier: z.number() }) },
      ),
    ).toThrow(/meta.x of role 'admin' is invalid/u);
    expect(() =>
      // SAFETY: a non-JSON value, as a JavaScript caller could pass it.
      defineRoles({ admin: { meta: { title: new Date() as never } } }),
    ).toThrow(/plain JSON/u);
    const plans = definePlans(
      { pro: { meta: { x: { seats: 5 } } } },
      { x: z.object({ seats: z.number() }) },
    );
    expect(plans.pro.meta.x).toEqual({ seats: 5 });
  });

  it("carries a custom role's meta onto assignableRoles, dropping an invalid x", async () => {
    const permissions = definePermissions({
      doc: resource({
        id: "id",
        actions: ["read", "update"],
        relations: { org: { field: "orgId", memberOf: "tenant" } },
      }),
    });
    const roles = defineRoles(
      { editor: { on: "tenant", assignable: true } },
      { x: z.object({ colour: z.string() }) },
    );
    const policy = definePolicy(
      { permissions, roles },
      {
        scopes: { tenant: { key: "orgId" } },
        roles: [
          role(
            roles.editor,
            [allow([permissions.doc.read, permissions.doc.update])],
            { on: "tenant" },
          ),
        ],
        subject: (user: { id: string } | null) =>
          user && {
            id: user.id,
            memberships: [{ tenant: "o_1", roles: ["editor", "reviewer"] }],
          },
      },
    );
    const customRoles = memoryCustomRoleSource([
      {
        name: "reviewer",
        tenant: "o_1",
        includes: ["editor"],
        meta: { title: "Reviewer", x: { colour: "teal" } },
      },
      {
        name: "auditor",
        tenant: "o_1",
        grants: [{ permission: "doc.read" }],
        // SAFETY: an invalid x, as a stored row could hold it.
        meta: { title: "Auditor", x: { colour: 7 } as never },
      },
    ]);
    const permdock = getPermDockSync(
      policy,
      { id: "u_1" },
      { customRoles, tenant: "o_1" },
    );
    const assignable = permdock.assignableRoles();
    expect(assignable.find((leaf) => leaf.key === "reviewer")?.meta).toEqual({
      title: "Reviewer",
      x: { colour: "teal" },
    });
    expect(assignable.find((leaf) => leaf.key === "auditor")?.meta).toEqual({
      title: "Auditor",
    });
  });
});

describe("grant meta", () => {
  const permissions = definePermissions({
    doc: resource({ actions: ["read", "delete"] }),
  });

  it("reports meta on decision.matched and keeps it out of the policy fingerprint", async () => {
    const make = (meta?: { readonly x: { readonly undo: number } }) =>
      definePolicy(permissions, {
        roles: [
          role("member", [
            allow(permissions.doc.delete, {
              name: "own-delete",
              ...(meta === undefined ? {} : { meta }),
            }),
          ]),
        ],
        subject: (user: { id: string } | null) =>
          user && { id: user.id, roles: ["member"] },
        x: { grant: z.object({ undo: z.number() }) },
      });
    const withMeta = make({ x: { undo: 30 } });
    const without = make();
    expect(withMeta.fingerprint).toBe(without.fingerprint);
    const permdock = getPermDockSync(withMeta, { id: "u_1" });
    const decision = permdock.decide(permissions.doc.delete, { id: "d_1" });
    expect(decision.outcome).toBe("granted");
    expect(decision.outcome === "granted" && decision.matched).toMatchObject({
      name: "own-delete",
      meta: { x: { undo: 30 } },
    });
  });

  it("throws at definePolicy on grant x that fails the schema", () => {
    expect(() =>
      definePolicy(permissions, {
        roles: [
          role("member", [
            allow(permissions.doc.read, { meta: { x: { undo: "soon" } } }),
          ]),
        ],
        subject: () => null,
        x: { grant: z.object({ undo: z.number() }) },
      }),
    ).toThrow(/meta.x of a grant on doc.read is invalid/u);
  });

  it("rejects meta that is not plain JSON", () => {
    expect(() =>
      // SAFETY: a non-JSON value, as a JavaScript caller could pass it.
      deny(permissions.doc.read, { meta: { description: 1 as never } }),
    ).toThrow(/must be a string/u);
  });
});

describe("membership x", () => {
  const permissions = definePermissions({
    doc: resource({
      id: "id",
      actions: ["read"],
      relations: { org: { field: "orgId", memberOf: "tenant" } },
    }),
  });
  const make = () =>
    definePolicy(permissions, {
      scopes: { tenant: { key: "orgId" } },
      roles: [role("viewer", [allow(permissions.doc.read)], { on: "tenant" })],
      subject: (user: { id: string; x: AppData } | null) =>
        user && {
          id: user.id,
          memberships: [{ tenant: "o_1", roles: ["viewer"], x: user.x }],
        },
      x: { membership: z.object({ department: z.string() }) },
    });

  it("keeps a valid x on the resolved membership", async () => {
    const permdock = getPermDockSync(make(), {
      id: "u_1",
      x: { department: "finance" },
    });
    expect(permdock.subject.principal?.memberships?.[0]?.x).toEqual({
      department: "finance",
    });
  });

  it("carries x through the snapshot to the client", async () => {
    const permdock = getPermDockSync(make(), {
      id: "u_1",
      x: { department: "finance" },
    });
    const client = fromSnapshot(
      parseSnapshot(JSON.stringify(permdock.snapshot())),
    );
    expect(client.memberships()[0]?.x).toEqual({ department: "finance" });
  });

  it("drops an invalid x, keeps the membership and reports it", async () => {
    const auth: unknown[] = [];
    const permdock = getPermDockSync(make(), {
      id: "u_1",
      x: { department: 1 },
    });
    permdock.on("auth", (event) => {
      auth.push(event);
    });
    const membership = permdock.subject.principal?.memberships?.[0];
    expect(membership?.roles).toEqual(["viewer"]);
    expect(membership?.x).toBeUndefined();
    expect(auth).toEqual([
      { reason: "schema", source: "memberships", cause: "x" },
    ]);
  });
});
