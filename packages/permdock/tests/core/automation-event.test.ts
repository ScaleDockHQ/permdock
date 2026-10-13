import { describe, expect, it } from "vitest";

import type { Automation } from "../../src/core/automation.ts";
import type { SupportSession } from "../../src/core/support-session.ts";

import { EVENT_SCHEMA_IDS } from "../../src/core/event-schemas.ts";
import {
  parseCloudEvent,
  parseSinkEvent,
} from "../../src/core/parse-sink-events.ts";
import {
  CLOUD_EVENT_TYPES,
  RESERVED_CLOUD_EVENT_TYPES,
  automationEvent,
  supportSessionEvent,
  toCloudEvent,
} from "../../src/core/sink.ts";

const source = "https://app.example.com";
const at = "2026-10-14T09:00:00.000Z";

const automation: Automation = {
  v: 1,
  id: "auto_1",
  version: 3,
  mode: "service",
  principal: "automation:auto_1",
  publishedBy: "u_1",
  publishedAt: at,
  tenant: "o_1",
  roles: ["billing"],
  operations: ["send_invoice"],
  permissions: ["invoice.send"],
  name: "Monthly invoices",
};

const session: SupportSession = {
  v: 1,
  id: "ss_1",
  principal: "u_1",
  actor: "staff_1",
  tenant: "o_1",
  reason: "Ticket 4411: invoice totals look wrong",
  permissions: ["invoice.read"],
  startedAt: at,
  expiresAt: "2026-10-14T10:00:00.000Z",
  approvedBy: "u_2",
};

describe("automation sink events", () => {
  it("maps each operation onto its com.permdock.automation type", () => {
    const types = {
      published: CLOUD_EVENT_TYPES.automationPublished,
      changed: CLOUD_EVENT_TYPES.automationChanged,
      revoked: CLOUD_EVENT_TYPES.automationRevoked,
    } as const;
    for (const [operation, type] of Object.entries(types)) {
      const event = automationEvent({
        // SAFETY: the keys of types are automation operations.
        operation: operation as keyof typeof types,
        automation,
        at,
      });
      const cloud = toCloudEvent(event, { source, id: operation });
      expect(cloud).toMatchObject({
        type,
        subject: "auto_1",
        dataschema: EVENT_SCHEMA_IDS.automation,
      });
      expect(parseCloudEvent(JSON.parse(JSON.stringify(cloud)))).toEqual(cloud);
    }
  });

  it("records the delegation and the run id on a run event", () => {
    const event = automationEvent({
      operation: "run",
      automation,
      run: "run_1",
      at,
    });
    expect(event).toEqual({
      type: "automation",
      at,
      source: "permdock",
      operation: "run",
      automation: {
        id: "auto_1",
        version: 3,
        mode: "service",
        name: "Monthly invoices",
      },
      principal: { id: "automation:auto_1" },
      publishedBy: "u_1",
      tenant: "o_1",
      roles: ["billing"],
      permissions: ["invoice.send"],
      run: { id: "run_1" },
    });
    expect(toCloudEvent(event, { source }).type).toBe(
      CLOUD_EVENT_TYPES.automationRun,
    );
  });

  it("puts run on run events only", () => {
    expect(() => automationEvent({ operation: "run", automation })).toThrow(
      TypeError,
    );
    expect(() =>
      automationEvent({ operation: "published", automation, run: "run_1" }),
    ).toThrow(TypeError);
    const run = automationEvent({ operation: "run", automation, run: "r" });
    expect(parseSinkEvent({ ...run, operation: "published" })).toBe(null);
    const { run: _run, ...withoutRun } = run;
    expect(parseSinkEvent(withoutRun)).toBe(null);
    expect(parseSinkEvent({ ...run, extra: true })).toBe(null);
  });

  it("is no longer reserved", () => {
    for (const type of RESERVED_CLOUD_EVENT_TYPES) {
      expect(type.startsWith("com.permdock.automation.")).toBe(false);
    }
  });
});

describe("support session sink events", () => {
  it("emits an access event on the support-session family", () => {
    const started = supportSessionEvent({
      operation: "started",
      session,
      source: "app",
      at,
    });
    expect(started).toEqual({
      type: "access",
      at,
      source: "app",
      operation: "started",
      tenant: "o_1",
      principal: { id: "staff_1" },
      via: "support-session",
      roles: [],
      expiresAt: "2026-10-14T10:00:00.000Z",
      grantedBy: "u_2",
      reason: "Ticket 4411: invoice totals look wrong",
      session: { id: "ss_1", principal: "u_1" },
      permissions: ["invoice.read"],
    });
    const cloud = toCloudEvent(started, { source });
    expect(cloud.type).toBe(CLOUD_EVENT_TYPES.supportSessionStarted);
    expect(parseCloudEvent(JSON.parse(JSON.stringify(cloud)))).toEqual(cloud);
    const ended = supportSessionEvent({ operation: "revoked", session });
    expect(toCloudEvent(ended, { source }).type).toBe(
      CLOUD_EVENT_TYPES.supportSessionEnded,
    );
  });
});
