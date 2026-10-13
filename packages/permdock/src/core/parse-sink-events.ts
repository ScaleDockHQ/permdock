import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { SinkEvent } from "./event-types.ts";

import { compact, isRecord } from "./compact.ts";
import {
  CATALOG_EVENT_SCHEMA,
  EVENT_SCHEMA_IDS,
  SINK_EVENT_SCHEMAS,
} from "./event-schemas.ts";
import { freezeDeep } from "./freeze.ts";
import { type JsonSchemaNode, checkSchema, copyJson } from "./json-schema.ts";
import { isForbiddenKey } from "./paths.ts";
import {
  CLOUD_EVENT_TYPES,
  type CatalogEventData,
  type CloudEvent,
  type CloudEventType,
  RESERVED_CLOUD_EVENT_TYPES,
  cloudEventType,
  isAbsoluteUri,
  isTraceparent,
} from "./sink.ts";
import { isRfc3339 } from "./time.ts";

function hasUnsafeKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasUnsafeKey);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(value).some(
    (key) => isForbiddenKey(key) || hasUnsafeKey(value[key]),
  );
}

/** A JSON copy of `value` that matches `schema`, or `null`. */
export function jsonMatching(
  value: unknown,
  schema: JsonSchemaNode,
): Record<string, unknown> | null {
  const issues: StandardSchemaV1.Issue[] = [];
  const copy = copyJson(value, [], issues, new Set());
  if (issues.length > 0 || !isRecord(copy) || hasUnsafeKey(copy)) {
    return null;
  }
  checkSchema(schema, copy, [], issues);
  return issues.length === 0 ? copy : null;
}

function timesValid(event: Record<string, unknown>): boolean {
  const membership = event["membership"];
  return (
    isRfc3339(event["at"]) &&
    (event["expiresAt"] === undefined || isRfc3339(event["expiresAt"])) &&
    (!isRecord(membership) ||
      membership["expiresAt"] === undefined ||
      isRfc3339(membership["expiresAt"]))
  );
}

function rulesHold(event: Record<string, unknown>): boolean {
  if (event["type"] === "membership") {
    return (
      (event["scope"] === undefined) === (event["id"] === undefined) &&
      (event["within"] === undefined || event["scope"] !== undefined)
    );
  }
  if (event["type"] === "credential") {
    return event["sample"] === undefined || event["operation"] === "used";
  }
  return true;
}

/**
 * Validates one untrusted sink event against its family's schema and returns
 * a frozen copy, or `null` for anything else. Never throws.
 */
export function parseSinkEvent(value: unknown): SinkEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const type = value["type"];
  if (typeof type !== "string" || !Object.hasOwn(SINK_EVENT_SCHEMAS, type)) {
    return null;
  }
  // SAFETY: Object.hasOwn checked that type is a key of SINK_EVENT_SCHEMAS.
  const schema = SINK_EVENT_SCHEMAS[type as keyof typeof SINK_EVENT_SCHEMAS];
  const copy = jsonMatching(value, schema);
  if (copy === null || !timesValid(copy) || !rulesHold(copy)) {
    return null;
  }
  // SAFETY: copy is a JSON copy that matched the schema of its event family.
  return freezeDeep(copy as SinkEvent);
}

/**
 * Validates an untrusted list of sink events, such as a request body a sink
 * receiver read. Each event that fails its schema is dropped, and a value
 * that is not an array yields no events. Never throws.
 */
export function parseSinkEvents(value: unknown): readonly SinkEvent[] {
  if (!Array.isArray(value)) {
    return Object.freeze([]);
  }
  return Object.freeze(
    value.flatMap((item: unknown) => {
      const event = parseSinkEvent(item);
      return event === null ? [] : [event];
    }),
  );
}

/** Validates the data of a `com.permdock.catalog.*` CloudEvent; `null` when it does not match. */
export function parseCatalogEventData(value: unknown): CatalogEventData | null {
  const copy = jsonMatching(value, CATALOG_EVENT_SCHEMA);
  // SAFETY: copy is a JSON copy that matched the catalog event schema.
  return copy === null ? null : freezeDeep(copy as CatalogEventData);
}

const RESERVED: ReadonlySet<string> = new Set(RESERVED_CLOUD_EVENT_TYPES);
const TYPES: ReadonlySet<string> = new Set(
  Object.values(CLOUD_EVENT_TYPES).filter((type) => !RESERVED.has(type)),
);

function catalogType(data: CatalogEventData): CloudEventType {
  return data.kind === "publish"
    ? CLOUD_EVENT_TYPES.catalogPublished
    : CLOUD_EVENT_TYPES.catalogDrifted;
}

function envelopeValid(value: Record<string, unknown>): boolean {
  return (
    value["specversion"] === "1.0" &&
    typeof value["type"] === "string" &&
    TYPES.has(value["type"]) &&
    isAbsoluteUri(value["source"]) &&
    typeof value["id"] === "string" &&
    value["id"] !== "" &&
    isRfc3339(value["time"]) &&
    (value["subject"] === undefined || typeof value["subject"] === "string") &&
    (value["datacontenttype"] === undefined ||
      value["datacontenttype"] === "application/json") &&
    (value["traceparent"] === undefined ||
      isTraceparent(value["traceparent"])) &&
    (value["tracestate"] === undefined ||
      typeof value["tracestate"] === "string")
  );
}

/**
 * Validates one CloudEvent against the closed type list, its `dataschema` and
 * its data shape; `null` for anything else, a reserved type included. Never
 * throws.
 */
export function parseCloudEvent(value: unknown): CloudEvent | null {
  if (!isRecord(value) || hasUnsafeKey(value) || !envelopeValid(value)) {
    return null;
  }
  const type = value["type"];
  const raw = value["data"];
  let data: SinkEvent | CatalogEventData | null;
  let expected: CloudEventType | undefined;
  let schema: string;
  if (
    type === CLOUD_EVENT_TYPES.catalogPublished ||
    type === CLOUD_EVENT_TYPES.catalogDrifted
  ) {
    const catalog = parseCatalogEventData(raw);
    data = catalog;
    expected = catalog === null ? undefined : catalogType(catalog);
    schema = EVENT_SCHEMA_IDS.catalog;
  } else {
    const event = parseSinkEvent(raw);
    data = event;
    expected = event === null ? undefined : cloudEventType(event);
    schema = event === null ? "" : EVENT_SCHEMA_IDS[event.type];
  }
  if (data === null || expected !== type || value["dataschema"] !== schema) {
    return null;
  }
  return freezeDeep(
    compact<CloudEvent>({
      specversion: "1.0",
      type: expected,
      source: value["source"],
      subject: value["subject"],
      id: value["id"],
      time: value["time"],
      datacontenttype: "application/json",
      dataschema: schema,
      traceparent: value["traceparent"],
      tracestate: value["tracestate"],
      data,
    }),
  );
}

/**
 * Validates a CloudEvents JSON batch (`application/cloudevents-batch+json`):
 * `null` unless the value is an array and every event in it is valid.
 */
export function parseCloudEventBatch(
  value: unknown,
): readonly CloudEvent[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const events: CloudEvent[] = [];
  for (const item of value) {
    const event = parseCloudEvent(item);
    if (event === null) {
      return null;
    }
    events.push(event);
  }
  return Object.freeze(events);
}
