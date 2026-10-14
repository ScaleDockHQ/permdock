import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type {
  DecisionEvent,
  DirectoryEvent,
  SinkEvent,
} from "../../src/core/event-types.ts";

import {
  CATALOG_EVENT_SCHEMA,
  EVENT_SCHEMA_IDS,
  SINK_EVENT_SCHEMAS,
} from "../../src/core/event-schemas.ts";
import {
  parseCatalogEventData,
  parseCloudEvent,
  parseCloudEventBatch,
  parseSinkEvent,
  parseSinkEvents,
} from "../../src/core/parse-sink-events.ts";
import {
  CLOUD_EVENT_TYPES,
  accessEvent,
  membershipEvent,
  toCloudEvent,
} from "../../src/core/sink.ts";
import * as root from "../../src/index.ts";

const source = "https://app.example.com";

const decision: DecisionEvent = {
  type: "decision",
  at: "2026-01-01T00:00:00.000Z",
  outcome: "denied",
  permission: "post.update",
  scope: "post:update",
  resource: { type: "post", id: "p1" },
  subject: {
    principal: { id: "u1", roles: ["member"], tenant: "o1" },
    actor: { kind: "agent", id: "assistant" },
    delegation: {
      scope: "post:read post:update",
      authorization_details: [{ type: "permdock" }],
    },
  },
  denials: [{ role: "member", reason: "no-grant" }],
  alternatives: ["post.read"],
  membership: {
    scope: "tenant",
    id: "o1",
    roles: ["member"],
    expiresAt: "2026-12-31T00:00:00Z",
  },
  trusted: false,
  call: "adapter",
  adapter: "agent",
  model: "openai/gpt-5",
};

const directory: DirectoryEvent = {
  type: "directory",
  at: "2026-01-01T00:00:00.000Z",
  source: "scim",
  operation: "replace",
  tenant: "o1",
  resource: { type: "User", id: "u1" },
  credential: { kind: "token" },
  active: true,
};

const families: readonly SinkEvent[] = [
  decision,
  directory,
  membershipEvent({
    source: "scim",
    operation: "added",
    principal: { id: "u1" },
    scope: "site",
    id: "s1",
    within: { organization: "o1" },
    roles: { added: ["technician"], removed: [] },
    expiresAt: "2026-12-31T00:00:00Z",
  }),
  {
    type: "credential",
    at: "2026-01-01T00:00:00.000Z",
    source: "permdock",
    operation: "used",
    credential: { id: "k1", kind: "service" },
    principal: { id: "ci" },
    tenant: "o1",
    sample: 0.5,
  },
  accessEvent({
    source: "app",
    operation: "started",
    tenant: "o1",
    principal: { id: "vendor-1" },
    roles: ["support"],
    expiresAt: 1_790_000_000,
  }),
  {
    type: "automation",
    at: "2026-01-01T00:00:00.000Z",
    source: "app",
    operation: "run",
    automation: { id: "a1", version: 3, mode: "publisher" },
    principal: { id: "u1" },
    publishedBy: "u1",
    tenant: "o1",
    permissions: ["post.read"],
    run: { id: "run_1" },
  },
  {
    type: "delivery",
    at: "2026-01-01T00:00:00.000Z",
    source: "app",
    operation: "failed",
    channel: "email",
    delivery: { id: "dlv_1", key: "pdd_1" },
    recipient: { principal: { id: "u1" } },
    category: "approval",
    approval: "apr_1",
    provider: { name: "resend" },
    cause: "rate-limited",
    retryable: true,
  },
];

function schemaFile(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../schemas/${name}`, import.meta.url), "utf8"),
  );
}

describe("event JSON Schemas", () => {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    allowUnionTypes: true,
  });
  ajv.addFormat("date-time", true);

  it("publishes each family schema as a file under its $id", () => {
    for (const [family, id] of Object.entries(EVENT_SCHEMA_IDS)) {
      const schema =
        family === "catalog"
          ? CATALOG_EVENT_SCHEMA
          : SINK_EVENT_SCHEMAS[
              // SAFETY: every key of EVENT_SCHEMA_IDS but catalog is a sink event type.
              family as SinkEvent["type"]
            ];
      expect(schema.$id).toBe(id);
      expect(schemaFile(`${family}-event-v1.json`)).toEqual(schema);
    }
  });

  it("agrees with Ajv on every family", () => {
    for (const event of families) {
      const validate = ajv.compile(SINK_EVENT_SCHEMAS[event.type]);
      const json: unknown = JSON.parse(JSON.stringify(event));
      expect({
        type: event.type,
        errors: validate(json) ? [] : validate.errors,
      }).toEqual({ type: event.type, errors: [] });
      expect(parseSinkEvent(json)).toEqual(event);
    }
  });
});

describe("the permdock entry", () => {
  it("exports the parsers and every event schema a receiver needs", () => {
    expect(root.parseSinkEvents).toBe(parseSinkEvents);
    expect(root.parseSinkEvent).toBe(parseSinkEvent);
    expect(root.parseCloudEvent).toBe(parseCloudEvent);
    expect(root.parseCloudEventBatch).toBe(parseCloudEventBatch);
    expect(root.parseCatalogEventData).toBe(parseCatalogEventData);
    expect(root.SINK_EVENT_SCHEMAS).toBe(SINK_EVENT_SCHEMAS);
    expect(root.CATALOG_EVENT_SCHEMA).toBe(CATALOG_EVENT_SCHEMA);
    expect(new Set(Object.keys(root.EVENT_SCHEMA_IDS))).toEqual(
      new Set([...Object.keys(SINK_EVENT_SCHEMAS), "catalog"]),
    );
  });

  it("maps every sink event family onto a CloudEvents type and back", () => {
    const produced = new Set(
      families.map((event) => toCloudEvent(event, { source }).type),
    );
    for (const type of produced) {
      expect(Object.values(CLOUD_EVENT_TYPES)).toContain(type);
    }
    expect(new Set(families.map((event) => event.type))).toEqual(
      new Set(Object.keys(SINK_EVENT_SCHEMAS)),
    );
  });
});

describe("parseSinkEvents", () => {
  it("returns frozen copies of valid events", () => {
    const parsed = parseSinkEvents(JSON.parse(JSON.stringify(families)));
    expect(parsed).toEqual(families);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed[0])).toBe(true);
  });

  it("drops each invalid event and keeps the rest", () => {
    const invalid: readonly unknown[] = [
      null,
      "decision",
      { ...decision, type: "audit" },
      { ...decision, extra: true },
      { ...decision, at: "2026-01-01" },
      { ...decision, at: "2026-13-01T00:00:00Z" },
      { ...decision, call: "check" },
      { ...decision, model: "" },
      { ...decision, model: 5 },
      { ...decision, membership: { ...decision.membership, expiresAt: 1 } },
      { ...directory, operation: "upsert" },
      JSON.parse(`{"type":"decision","__proto__":{"trusted":true}}`),
      {
        ...families[2],
        scope: undefined,
      },
      {
        ...families[2],
        within: { organization: "o1" },
        scope: undefined,
        id: undefined,
      },
      { ...families[3], operation: "created" },
      { ...families[3], sample: 0 },
      { ...families[3], sample: 1.5 },
      { ...families[4], expiresAt: "tomorrow" },
    ];
    expect(parseSinkEvents([...invalid, decision])).toEqual([decision]);
  });

  it("returns an empty list for anything but an array", () => {
    expect(parseSinkEvents({ events: [decision] })).toEqual([]);
    expect(parseSinkEvents(undefined)).toEqual([]);
  });
});

describe("parseCloudEvent", () => {
  it("round-trips every family through JSON", () => {
    for (const event of families) {
      const cloud = toCloudEvent(event, { source });
      const parsed = parseCloudEvent(JSON.parse(JSON.stringify(cloud)));
      expect(parsed).toEqual(cloud);
      expect(Object.isFrozen(parsed)).toBe(true);
    }
  });

  it("parses catalog data and types it by kind", () => {
    const data = {
      kind: "drift",
      fingerprint: "sha256:abc",
      previous: "sha256:def",
    };
    expect(parseCatalogEventData(data)).toEqual(data);
    expect(parseCatalogEventData({ ...data, kind: "sync" })).toBeNull();
    expect(parseCatalogEventData("catalog")).toBeNull();
    const envelope = {
      specversion: "1.0",
      type: CLOUD_EVENT_TYPES.catalogDrifted,
      source,
      id: "evt_1",
      time: "2026-01-01T00:00:00Z",
      datacontenttype: "application/json",
      dataschema: EVENT_SCHEMA_IDS.catalog,
      data,
    };
    expect(parseCloudEvent(envelope)?.data).toEqual(data);
    expect(
      parseCloudEvent({
        ...envelope,
        type: CLOUD_EVENT_TYPES.catalogPublished,
      }),
    ).toBeNull();
  });

  it("rejects envelopes that break CloudEvents or PermDock rules", () => {
    const good: Record<string, unknown> = JSON.parse(
      JSON.stringify(toCloudEvent(decision, { source })),
    );
    expect(parseCloudEvent(good)).not.toBeNull();
    for (const patch of [
      { specversion: "0.3" },
      { type: "dev.permdock.decision" },
      { type: CLOUD_EVENT_TYPES.deliverySent },
      { type: CLOUD_EVENT_TYPES.membershipAdded },
      { source: "app" },
      { id: "" },
      { time: "yesterday" },
      { subject: 1 },
      { datacontenttype: "text/plain" },
      { dataschema: "https://permdock.com/schemas/access-event-v1.json" },
      { traceparent: "00-xyz" },
      { data: { ...decision, outcome: "maybe" } },
    ]) {
      expect({ patch, parsed: parseCloudEvent({ ...good, ...patch }) }).toEqual(
        { patch, parsed: null },
      );
    }
    expect(parseCloudEvent([good])).toBeNull();
  });

  it("accepts a batch only when every event is valid", () => {
    const events = families.map((event) =>
      JSON.parse(JSON.stringify(toCloudEvent(event, { source }))),
    );
    expect(parseCloudEventBatch(events)).toHaveLength(families.length);
    expect(
      parseCloudEventBatch([...events, { specversion: "1.0" }]),
    ).toBeNull();
    expect(parseCloudEventBatch(events[0])).toBeNull();
  });
});
