import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";

import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { memorySettingsSource } from "../../src/core/memory-sources.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import {
  type SupportSession,
  parseSupportSession,
} from "../../src/core/support-session.ts";
import { decideSupportSession } from "../../src/index.ts";
import {
  permdockFor,
  permissions,
  person,
  policy,
  userSubject,
} from "../fixtures/automation.ts";

const NOW = Temporal.Instant.from("2026-10-14T09:00:00Z");

const session: SupportSession = {
  v: 1,
  id: "ss_1",
  principal: "u_customer",
  actor: "u_staff",
  tenant: "o_1",
  reason: "Ticket 4411: invoice totals look wrong",
  permissions: ["invoice.read"],
  startedAt: "2026-10-14T09:00:00.000Z",
  expiresAt: "2026-10-14T10:00:00.000Z",
};

const request = {
  id: "ss_1",
  principal: "u_customer",
  reason: "Ticket 4411: invoice totals look wrong",
};

describe("parseSupportSession", () => {
  it("keeps the v1 fields and freezes the copy", () => {
    expect(parseSupportSession({ ...session, extra: 1 })).toStrictEqual(
      session,
    );
    expect(Object.isFrozen(parseSupportSession(session))).toBe(true);
  });

  it("rejects a wrong shape in any field", () => {
    const rows: readonly unknown[] = [
      null,
      { ...session, v: 2 },
      { ...session, actor: "u_customer" },
      { ...session, tenant: "" },
      { ...session, reason: "   " },
      { ...session, reason: "x".repeat(1001) },
      { ...session, permissions: [] },
      { ...session, expiresAt: session.startedAt },
      { ...session, approvedBy: "u_staff" },
      { ...session, approvedBy: 3 },
      { ...session, reference: "" },
    ];
    for (const row of rows) {
      expect(parseSupportSession(row)).toBeUndefined();
    }
  });
});

describe("decideSupportSession", () => {
  const staff = permdockFor(userSubject("u_staff", ["billing"]));

  it("asks for approval by default and defaults to the actor's read-only permissions", async () => {
    const decision = await decideSupportSession(staff, request, { now: NOW });
    expect(decision).toMatchObject({
      outcome: "approval-required",
      session,
      token: expect.stringMatching(/^sha-256:/u),
    });
  });

  it("grants once approved by someone other than the actor", async () => {
    const pending = await decideSupportSession(staff, request, { now: NOW });
    if (pending.outcome !== "approval-required") {
      throw new Error("expected approval-required");
    }
    const later = NOW.add({ minutes: 5 });
    expect(
      await decideSupportSession(staff, request, {
        now: later,
        approved: pending.token,
        approvedBy: "u_lead",
      }),
    ).toStrictEqual({
      outcome: "granted",
      session: {
        ...session,
        startedAt: "2026-10-14T09:05:00.000Z",
        expiresAt: "2026-10-14T10:05:00.000Z",
        approvedBy: "u_lead",
      },
    });
  });

  it("refuses the actor as their own approver, or no approver", async () => {
    const pending = await decideSupportSession(staff, request, { now: NOW });
    if (pending.outcome !== "approval-required") {
      throw new Error("expected approval-required");
    }
    for (const approvedBy of ["u_staff", undefined]) {
      expect(
        await decideSupportSession(staff, request, {
          approved: pending.token,
          ...(approvedBy === undefined ? {} : { approvedBy }),
        }),
      ).toMatchObject({
        outcome: "denied",
        denials: [{ reason: "approval", detail: "approver-not-distinct" }],
      });
    }
  });

  it("binds the token to the request: a wider session asks again", async () => {
    const pending = await decideSupportSession(staff, request, { now: NOW });
    if (pending.outcome !== "approval-required") {
      throw new Error("expected approval-required");
    }
    const wider = await decideSupportSession(
      staff,
      {
        ...request,
        permissions: [permissions.invoice.read, permissions.invoice.send],
      },
      { approved: pending.token, approvedBy: "u_lead" },
    );
    expect(wider.outcome).toBe("approval-required");
  });

  it("grants without approval only when the server turns it off", async () => {
    expect(
      (await decideSupportSession(staff, request, { approval: false })).outcome,
    ).toBe("granted");
  });

  it("requires a reason", async () => {
    for (const reason of ["", "  ", "x".repeat(1001)]) {
      expect(
        await decideSupportSession(staff, { ...request, reason }),
      ).toMatchObject({ denials: [{ reason: "reason-required" }] });
    }
  });

  it("refuses anonymous, non-person, credential, run and delegated actors", async () => {
    expect(
      await decideSupportSession(
        permdockFor({ principal: null, context: {} }),
        request,
      ),
    ).toMatchObject({ denials: [{ reason: "anonymous" }] });
    for (const kind of ["service", "contact", "link"] as const) {
      const instance = permdockFor({
        principal: { ...person("u_staff", ["billing"]), kind },
        context: {},
      });
      expect(await decideSupportSession(instance, request)).toMatchObject({
        denials: [{ reason: "exceeds-creator", detail: { creator: kind } }],
      });
    }
    const viaKey = permdockFor({
      principal: { ...person("u_staff", ["billing"]), credential: { id: "k" } },
      context: {},
    });
    expect(await decideSupportSession(viaKey, request)).toMatchObject({
      denials: [{ detail: { creator: "credential" } }],
    });
    const viaRun = permdockFor({
      principal: { ...person("u_staff", ["billing"]), runTicket: { jti: "r" } },
      context: {},
    });
    expect(await decideSupportSession(viaRun, request)).toMatchObject({
      denials: [{ detail: { creator: "run" } }],
    });
    const viaAgent = permdockFor(
      userSubject("u_staff", ["billing"], {
        actor: { id: "agent_1", kind: "agent" },
      }),
    );
    expect(await decideSupportSession(viaAgent, request)).toMatchObject({
      denials: [{ detail: { creator: "actor" } }],
    });
  });

  it("refuses invalid requests and tenants the actor is not in", async () => {
    const rows = [
      { ...request, id: "" },
      { ...request, principal: "u_staff" },
      { ...request, expiresIn: 0 },
      { ...request, expiresIn: 86_401 },
      { ...request, reference: "" },
      {
        ...request,
        permissions: [{ ...permissions.invoice.read, key: "nope" }],
      },
    ];
    for (const row of rows) {
      expect(await decideSupportSession(staff, row)).toMatchObject({
        denials: [{ reason: "validation" }],
      });
    }
    expect(
      await decideSupportSession(staff, { ...request, tenant: "o_2" }),
    ).toMatchObject({ denials: [{ reason: "tenant-mismatch" }] });
    const noTenant = permdockFor({
      principal: { id: "u_staff", kind: "user" },
      context: {},
    });
    expect(await decideSupportSession(noTenant, request)).toMatchObject({
      denials: [{ reason: "validation" }],
    });
  });

  it("caps the session at the actor's reach and needs at least one permission", async () => {
    expect(
      await decideSupportSession(staff, {
        ...request,
        permissions: [permissions.invoice.delete],
      }),
    ).toMatchObject({
      denials: [
        { reason: "exceeds-creator", detail: { permission: "invoice.delete" } },
      ],
    });
    const nobody = permdockFor(userSubject("u_staff", []));
    const member = getPermDockSync(policy, {
      principal: {
        id: "u_staff",
        kind: "user",
        tenant: "o_1",
        memberships: [{ tenant: "o_1", roles: [] }],
      },
      context: {},
    });
    expect(await decideSupportSession(member, request)).toMatchObject({
      denials: [{ reason: "no-grant" }],
    });
    expect((await decideSupportSession(nobody, request)).outcome).toBe(
      "denied",
    );
  });

  it("applies the tenant's supportSessions policy, which only tightens", async () => {
    const settings = memorySettingsSource({
      o_1: { supportSessions: { maxTtl: 600, readOnly: true } },
    });
    expect(
      await decideSupportSession(staff, request, { settings }),
    ).toMatchObject({
      denials: [{ reason: "validation", detail: { rule: "ttl" } }],
    });
    expect(
      await decideSupportSession(
        staff,
        { ...request, expiresIn: 600, permissions: [permissions.invoice.send] },
        { settings },
      ),
    ).toMatchObject({
      denials: [
        {
          reason: "not-delegated",
          detail: { permission: "invoice.send", rule: "read-only" },
        },
      ],
    });
    const disabled = memorySettingsSource({
      o_1: { supportSessions: { disabled: true } },
    });
    expect(
      await decideSupportSession(staff, request, { settings: disabled }),
    ).toMatchObject({
      denials: [{ reason: "unsupported", detail: { rule: "disabled" } }],
    });
    const broken = {
      settingsFor(): never {
        throw new Error("down");
      },
    };
    expect(
      await decideSupportSession(staff, request, { settings: broken }),
    ).toMatchObject({
      denials: [{ reason: "unsupported", detail: { rule: "unavailable" } }],
    });
  });

  it("reads the instance's settings option", async () => {
    const instance = getPermDockSync(
      policy,
      userSubject("u_staff", ["billing"]),
      {
        settings: memorySettingsSource({
          o_1: { supportSessions: { disabled: true } },
        }),
      },
    );
    expect(await decideSupportSession(instance, request)).toMatchObject({
      denials: [{ reason: "unsupported" }],
    });
  });

  it("denies with unsupported on an instance built from a snapshot", async () => {
    const snapshot = staff.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError("expected a JSON snapshot");
    }
    expect(
      await decideSupportSession(fromSnapshot(snapshot), request),
    ).toMatchObject({ denials: [{ reason: "unsupported" }] });
  });
});
