import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";

import {
  type Automation,
  memoryAutomationSource,
  parseAutomation,
} from "../../src/core/automation.ts";
import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { decideAutomation } from "../../src/index.ts";
import {
  operations,
  permdockFor,
  permissions,
  person,
  userSubject,
} from "../fixtures/automation.ts";

const NOW = Temporal.Instant.from("2026-10-14T09:00:00Z");

const record: Automation = {
  v: 1,
  id: "auto_1",
  version: 1,
  mode: "publisher",
  principal: "u_1",
  publishedBy: "u_1",
  publishedAt: "2026-10-14T09:00:00.000Z",
  tenant: "o_1",
  operations: ["read_invoice", "send_invoice"],
  permissions: ["invoice.read", "invoice.send"],
};

const service: Automation = {
  ...record,
  id: "auto_2",
  mode: "service",
  principal: "automation:auto_2",
  roles: ["billing"],
};

describe("parseAutomation", () => {
  it("keeps the v1 fields and freezes the copy", () => {
    expect(parseAutomation({ ...record, extra: true })).toEqual(record);
    expect(parseAutomation(service)).toEqual(service);
    expect(Object.isFrozen(parseAutomation(record))).toBe(true);
    expect(parseAutomation({ ...record, revoked: false })).toEqual(record);
  });

  it("rejects a wrong shape in any field", () => {
    const rows: readonly unknown[] = [
      null,
      [],
      { ...record, v: 2 },
      { ...record, id: "" },
      { ...record, version: -1 },
      { ...record, version: 1.5 },
      { ...record, mode: "agent" },
      { ...record, publishedAt: "yesterday" },
      { ...record, operations: [] },
      { ...record, permissions: [7] },
      { ...record, tenant: "" },
      { ...record, run: 3 },
      { ...record, revoked: "yes" },
      { ...record, name: "x".repeat(257) },
      { ...record, roles: ["billing"] },
      { ...record, principal: "u_2" },
      { ...service, tenant: undefined },
      { ...service, roles: undefined },
      { ...service, roles: [] },
    ];
    for (const row of rows) {
      expect(parseAutomation(row)).toBeUndefined();
    }
  });
});

describe("memoryAutomationSource", () => {
  it("returns a record by id, scoped to a tenant, and replaces on put", () => {
    const source = memoryAutomationSource([record]);
    expect(source.automation("auto_1")).toEqual(record);
    expect(source.automation("auto_1", { tenant: "o_1" })).toEqual(record);
    expect(source.automation("auto_1", { tenant: "o_2" })).toBeNull();
    expect(source.automation("missing")).toBeNull();
    source.put({ ...record, version: 2 });
    expect(source.automation("auto_1")?.version).toBe(2);
  });

  it("throws on an invalid record", () => {
    const source = memoryAutomationSource();
    expect(() => source.put({ ...record, operations: [] })).toThrow(TypeError);
  });
});

describe("decideAutomation", () => {
  const billing = permdockFor(userSubject("u_1", ["billing"]));
  const owner = permdockFor(userSubject("u_1", ["owner"]));
  const request = {
    id: "auto_1",
    version: 1,
    operations: [operations.read_invoice, operations.send_invoice],
  };

  it("grants a publisher automation whose delegation is the operations' permissions", async () => {
    const decision = await decideAutomation(
      billing,
      { ...request, run: permissions.report.run, name: "Monthly invoices" },
      { now: NOW },
    );
    expect(decision).toEqual({
      outcome: "granted",
      automation: {
        ...record,
        run: "report.run",
        name: "Monthly invoices",
      },
    });
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it("accepts the OperationMap itself and keeps one key per permission", async () => {
    const decision = await decideAutomation(
      owner,
      { id: "auto_1", version: "v2", operations },
      { now: NOW },
    );
    expect(decision.outcome).toBe("granted");
    if (decision.outcome === "granted") {
      expect(decision.automation.operations).toEqual([
        "read_invoice",
        "send_invoice",
        "delete_invoice",
      ]);
      expect(decision.automation.permissions).toEqual([
        "invoice.read",
        "invoice.send",
        "invoice.delete",
      ]);
    }
  });

  it("caps the delegation at what the publisher can use now", async () => {
    expect(
      await decideAutomation(billing, {
        ...request,
        operations: [operations.delete_invoice],
      }),
    ).toMatchObject({
      outcome: "denied",
      denials: [
        { reason: "exceeds-creator", detail: { permission: "invoice.delete" } },
      ],
    });
    const reader = permdockFor(userSubject("u_3", ["reader"]));
    expect(await decideAutomation(reader, request)).toMatchObject({
      denials: [{ detail: { permission: "invoice.send" } }],
    });
  });

  it("refuses anonymous, link, feed, contact, credential and run publishers", async () => {
    expect(
      await decideAutomation(
        permdockFor({ principal: null, context: {} }),
        request,
      ),
    ).toMatchObject({ denials: [{ reason: "anonymous" }] });
    for (const kind of ["link", "feed", "contact"] as const) {
      const subject = userSubject("u_1", ["owner"]);
      const instance = permdockFor({
        ...subject,
        principal: { ...person("u_1", ["owner"]), kind },
      });
      expect(await decideAutomation(instance, request)).toMatchObject({
        denials: [{ reason: "exceeds-creator", detail: { creator: kind } }],
      });
    }
    const viaKey = permdockFor({
      principal: { ...person("u_1", ["owner"]), credential: { id: "key_1" } },
      context: {},
    });
    expect(await decideAutomation(viaKey, request)).toMatchObject({
      denials: [{ detail: { creator: "credential" } }],
    });
    const viaRun = permdockFor({
      principal: { ...person("u_1", ["owner"]), runTicket: { jti: "r" } },
      context: {},
    });
    expect(await decideAutomation(viaRun, request)).toMatchObject({
      denials: [{ detail: { creator: "run" } }],
    });
  });

  it("refuses invalid requests with validation", async () => {
    const rows = [
      { ...request, id: "" },
      { ...request, version: -1 },
      { ...request, operations: [] },
      {
        ...request,
        operations: [operations.read_invoice, operations.read_invoice],
      },
      {
        ...request,
        operations: [
          {
            name: "x",
            permission: { ...permissions.invoice.read, key: "nope" },
          },
        ],
      },
      { ...request, run: { ...permissions.report.run, key: "nope" } },
      { ...request, mode: "service" as const },
      // SAFETY: an untyped caller passing an unknown mode; the decision must refuse it.
      { ...request, mode: "agent" as never },
    ];
    for (const row of rows) {
      expect(await decideAutomation(owner, row)).toMatchObject({
        outcome: "denied",
        denials: [{ reason: "validation" }],
      });
    }
  });

  it("refuses a tenant the publisher is not a member of", async () => {
    expect(
      await decideAutomation(owner, { ...request, tenant: "o_2" }),
    ).toMatchObject({
      denials: [{ reason: "exceeds-creator", detail: { tenant: "o_2" } }],
    });
  });

  it("caps a service automation at the publisher's assignable roles and permissions", async () => {
    const granted = await decideAutomation(
      owner,
      { ...request, id: "auto_2", mode: "service", roles: ["billing"] },
      { now: NOW },
    );
    expect(granted).toEqual({ outcome: "granted", automation: service });
    expect(
      await decideAutomation(billing, {
        ...request,
        mode: "service",
        roles: ["owner"],
      }),
    ).toMatchObject({
      denials: [{ reason: "exceeds-creator", detail: { role: "owner" } }],
    });
  });

  it("denies with unsupported on an instance built from a snapshot", async () => {
    const snapshot = owner.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError("expected a JSON snapshot");
    }
    expect(
      await decideAutomation(fromSnapshot(snapshot), request),
    ).toMatchObject({
      denials: [{ reason: "unsupported" }],
    });
  });
});
