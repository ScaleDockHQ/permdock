import { Ajv } from "ajv";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type {
  DecisionEvent,
  DirectoryEvent,
  SinkEvent,
} from "../../src/core/event-types.ts";

import { EVENT_SCHEMA_IDS } from "../../src/core/event-schemas.ts";
import {
  parseCloudEvent,
  parseCloudEventBatch,
} from "../../src/core/parse-sink-events.ts";
import {
  CLOUDEVENTS_BATCH_CONTENT_TYPE,
  CLOUDEVENTS_CONTENT_TYPE,
  CLOUD_EVENT_TYPES,
  RESERVED_CLOUD_EVENT_TYPES,
  accessEvent,
  membershipEvent,
  toCloudEvent,
} from "../../src/core/sink.ts";
import { standardsFixture } from "./fixtures.ts";

const source = "https://app.example.com";
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

const decision: DecisionEvent = {
  type: "decision",
  at: "2026-01-01T00:00:00.000Z",
  outcome: "granted",
  permission: "post.read",
  scope: "post:read",
  resource: { type: "post", id: "p1" },
  subject: { principal: { id: "u1", roles: ["member"] } },
  denials: [],
  alternatives: [],
  trusted: true,
  call: "decide",
};

const directory: DirectoryEvent = {
  type: "directory",
  at: "2026-01-01T00:00:00.000Z",
  source: "scim",
  operation: "create",
  tenant: "o1",
  resource: { type: "User", id: "u1" },
  credential: { kind: "token" },
};

const events: readonly SinkEvent[] = [
  decision,
  { ...decision, outcome: "approval-required", phase: "requested" },
  directory,
  membershipEvent({
    source: "scim",
    operation: "added",
    principal: { id: "u1" },
    scope: "tenant",
    id: "o1",
    roles: { added: ["editor"], removed: [] },
  }),
  {
    type: "credential",
    at: "2026-01-01T00:00:00.000Z",
    source: "permdock",
    operation: "created",
    credential: { id: "k1", kind: "service" },
    principal: { id: "ci" },
  },
  accessEvent({
    source: "app",
    operation: "started",
    tenant: "o1",
    principal: { id: "vendor-1" },
    roles: ["support"],
    expiresAt: 1_790_000_000,
  }),
];

const validate = new Ajv({ strict: false }).compile(
  standardsFixture("cloudevents-1.0.2.schema.json"),
);

describe("CloudEvents 1.0.2 JSON format", () => {
  it.each(events.map((event) => [event.type, event] as const))(
    "a %s event validates against the CloudEvents JSON Schema",
    (_family, event) => {
      const cloudEvent = toCloudEvent(event, { source, traceparent });
      expect({
        valid: validate(cloudEvent),
        errors: validate.errors ?? null,
      }).toEqual({ valid: true, errors: null });
    },
  );

  it("section 3.1.1: attribute names are lower-case a-z and 0-9, at most 20 characters", () => {
    for (const event of events) {
      for (const name of Object.keys(
        toCloudEvent(event, { source, traceparent, tracestate: "pd=1" }),
      )) {
        expect(name).toMatch(/^[a-z0-9]{1,20}$/u);
      }
    }
  });

  it("section 3.1.1: type is prefixed with a reverse-DNS name", () => {
    for (const type of Object.values(CLOUD_EVENT_TYPES)) {
      expect(type).toMatch(/^com\.permdock\.[a-z-]+(\.[a-z-]+)?$/u);
    }
  });

  it("source is an absolute URI, stricter than the URI-reference the spec allows", () => {
    expect(() => toCloudEvent(decision, { source: "/app" })).toThrow(TypeError);
  });

  it("time is the event's RFC 3339 instant and dataschema names the family schema", () => {
    for (const event of events) {
      const cloudEvent = toCloudEvent(event, { source });
      expect(cloudEvent.time).toBe(event.at);
      expect(cloudEvent.dataschema).toBe(EVENT_SCHEMA_IDS[event.type]);
      expect(cloudEvent.datacontenttype).toBe("application/json");
    }
  });

  it("the distributed tracing extension carries W3C traceparent and tracestate", () => {
    const cloudEvent = toCloudEvent(decision, {
      source,
      traceparent,
      tracestate: "pd=1",
    });
    expect(cloudEvent).toMatchObject({ traceparent, tracestate: "pd=1" });
    expect(() =>
      toCloudEvent(decision, { source, traceparent: "not-a-trace" }),
    ).toThrow(TypeError);
    expect(
      toCloudEvent(decision, { source, tracestate: "pd=1" }),
    ).not.toHaveProperty("tracestate");
  });
});

describe("CloudEvents JSON batch format", () => {
  it("names the structured and batched media types", () => {
    expect(CLOUDEVENTS_CONTENT_TYPE).toBe("application/cloudevents+json");
    expect(CLOUDEVENTS_BATCH_CONTENT_TYPE).toBe(
      "application/cloudevents-batch+json",
    );
  });

  it("a batch is a JSON array of events that round-trips through parseCloudEventBatch", () => {
    const batch = events.map((event, index) =>
      toCloudEvent(event, { source, id: `e${index}` }),
    );
    const wire: unknown = JSON.parse(JSON.stringify(batch));
    expect(parseCloudEventBatch(wire)).toEqual(batch);
    expect(parseCloudEventBatch([])).toEqual([]);
  });

  it("one invalid event rejects the whole batch", () => {
    const good = toCloudEvent(decision, { source, id: "e1" });
    expect(parseCloudEventBatch([good, { ...good, specversion: "0.3" }])).toBe(
      null,
    );
    expect(parseCloudEventBatch(good)).toBe(null);
  });

  it("refuses a reserved type and a dataschema that does not match the data", () => {
    const good = toCloudEvent(decision, { source, id: "e1" });
    for (const type of RESERVED_CLOUD_EVENT_TYPES) {
      expect(parseCloudEvent({ ...good, type })).toBe(null);
    }
    expect(
      parseCloudEvent({ ...good, dataschema: EVENT_SCHEMA_IDS.directory }),
    ).toBe(null);
    expect(
      parseCloudEvent({ ...good, type: CLOUD_EVENT_TYPES.approvalResolved }),
    ).toBe(null);
  });
});

describe("the CloudEvents page", () => {
  const page = readFileSync(
    path.join(
      import.meta.dirname,
      "../../../../apps/docs/content/docs/standards/cloudevents.mdx",
    ),
    "utf8",
  );

  it("lists every type, and marks exactly the reserved ones", () => {
    const rows = page
      .split("\n")
      .filter((line) => line.startsWith("| `com.permdock."));
    const listed = rows.map((line) => /^\| `([^`]+)`/u.exec(line)?.[1]);
    expect(listed).toHaveLength(Object.values(CLOUD_EVENT_TYPES).length);
    expect(new Set(listed)).toEqual(new Set(Object.values(CLOUD_EVENT_TYPES)));
    const reserved = rows
      .filter((line) => line.includes("Reserved"))
      .map((line) => /^\| `([^`]+)`/u.exec(line)?.[1]);
    expect(new Set(reserved)).toEqual(new Set(RESERVED_CLOUD_EVENT_TYPES));
    expect(reserved).toHaveLength(RESERVED_CLOUD_EVENT_TYPES.length);
  });
});
