import type { TokenSigner } from "../core/interfaces.ts";
import type { SsfStream, SsfStreamStore } from "./streams.ts";
import type {
  SetDelivery,
  SetEvent,
  SetQueue,
  SsfStreamConfiguration,
  SsfStreamStatus,
  SsfTransmitterConfiguration,
} from "./types.ts";

import { compact, isRecord } from "../core/compact.ts";
import { statusProblem } from "../core/problem-types.ts";
import { readBodyText } from "../server/body-text.ts";
import {
  methodNotAllowed,
  notFoundProblem,
  problemResponse,
  validationProblem,
} from "../server/problem.ts";
import { knownEventTypes } from "./events.ts";
import { setPollHandler } from "./set-queue.ts";
import {
  SSF_POLL_DELIVERY,
  SSF_PUSH_DELIVERY,
  pushSet,
  signSet,
  streamVerificationEvent,
} from "./transmitter.ts";
import { jsonResponse } from "./wire.ts";

/** The largest stream-management request body read. */
const MAX_BODY_BYTES = 65_536;
/** SETs drained or flushed per queue read. */
const BATCH = 100;
const STATUSES: readonly SsfStreamStatus["status"][] = [
  "enabled",
  "paused",
  "disabled",
];

export type SsfTransmitterOptions = {
  /** `iss` of every stream and of the metadata; the `iss` the signer writes. */
  readonly issuer: string;
  /** The URL the handler is mounted at; endpoints are `<endpoint>/stream`, `/status`, `/verify` and `/poll`. Default `issuer`. */
  readonly endpoint?: string;
  readonly streams: SsfStreamStore;
  readonly queue: SetQueue;
  readonly signer: TokenSigner;
  /** The receiver the request's credentials authenticate, or `null` to refuse it with `401`. */
  readonly authorize: (
    request: Request,
  ) => string | null | Promise<string | null>;
  /** `aud` of a receiver's streams; default the receiver itself. */
  readonly audience?: (receiver: string) => string | readonly string[];
  readonly jwksUri?: string;
  /** Default every CAEP and RISC event PermDock's receiver handles. */
  readonly eventsSupported?: readonly string[];
  /** The largest `maxEvents` a poll is answered with; default 100. */
  readonly maxEvents?: number;
  readonly fetch?: typeof fetch;
};

export type FanOutSetOptions = {
  readonly streams: SsfStreamStore;
  readonly queue: SetQueue;
  readonly signer: TokenSigner;
  readonly fetch?: typeof fetch;
};

/** How one stream took a SET. `queued` is `true` for a poll stream and for a paused push stream. */
export type SsfFanOut = {
  readonly stream: string;
  readonly jti: string;
  readonly queued: boolean;
  readonly delivery: SetDelivery;
};

type ReceiverProperties = {
  readonly delivery: SsfStreamConfiguration["delivery"];
  readonly events_requested: readonly string[];
  readonly description?: string;
};

function isStatus(value: unknown): value is SsfStreamStatus["status"] {
  return STATUSES.some((status) => status === value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !URL.canParse(value)) {
    return false;
  }
  const { protocol } = new URL(value);
  return protocol === "https:" || protocol === "http:";
}

function readDelivery(
  value: unknown,
): SsfStreamConfiguration["delivery"] | string {
  if (!isRecord(value)) {
    return "delivery must be an object";
  }
  const { method, endpoint_url, authorization_header } = value;
  if (method === SSF_POLL_DELIVERY) {
    return { method };
  }
  if (method !== SSF_PUSH_DELIVERY) {
    return `delivery.method must be ${SSF_PUSH_DELIVERY} or ${SSF_POLL_DELIVERY}`;
  }
  if (!isHttpUrl(endpoint_url)) {
    return "delivery.endpoint_url must be an http or https URL for push";
  }
  if (
    authorization_header !== undefined &&
    typeof authorization_header !== "string"
  ) {
    return "delivery.authorization_header must be a string";
  }
  return compact({ method, endpoint_url, authorization_header });
}

/**
 * The receiver-supplied properties of a stream request (SSF 1.0 section
 * 8.1.1). `previous` keeps the properties a PATCH leaves out; without it an
 * absent property takes its default. Transmitter-supplied properties are ignored.
 */
function readProperties(
  body: Readonly<Record<string, unknown>>,
  previous?: ReceiverProperties,
): ReceiverProperties | string {
  let delivery = previous?.delivery ?? { method: SSF_POLL_DELIVERY };
  if (body["delivery"] !== undefined) {
    const read = readDelivery(body["delivery"]);
    if (typeof read === "string") {
      return read;
    }
    delivery = read;
  }
  const requested = body["events_requested"];
  if (
    requested !== undefined &&
    !(
      Array.isArray(requested) &&
      requested.every((event) => typeof event === "string")
    )
  ) {
    return "events_requested must be an array of strings";
  }
  const description = body["description"];
  if (description !== undefined && typeof description !== "string") {
    return "description must be a string";
  }
  return compact<ReceiverProperties>({
    delivery,
    events_requested: requested ?? previous?.events_requested ?? [],
    description: description ?? previous?.description,
  });
}

function propertiesOf(
  configuration: SsfStreamConfiguration,
): ReceiverProperties {
  return compact<ReceiverProperties>({
    delivery: configuration.delivery,
    events_requested: configuration.events_requested ?? [],
    description: configuration.description,
  });
}

async function readBody(
  request: Request,
): Promise<Readonly<Record<string, unknown>> | Response> {
  const read = await readBodyText(request, MAX_BODY_BYTES);
  if (!read.ok) {
    return problemResponse(
      statusProblem(413, `request body exceeds ${MAX_BODY_BYTES} bytes`),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return validationProblem("body was not valid JSON");
  }
  return isRecord(parsed)
    ? parsed
    : validationProblem("body must be a JSON object");
}

async function owned(
  streams: SsfStreamStore,
  id: unknown,
  owner: string,
): Promise<SsfStream | Response> {
  if (typeof id !== "string" || id === "") {
    return validationProblem("stream_id is required");
  }
  const stream = await streams.get(id);
  return stream?.owner === owner ? stream : notFoundProblem();
}

/** Acknowledges every pending SET of `stream`; a queue that never empties is read at most until it repeats. */
async function drain(queue: SetQueue, stream: string): Promise<void> {
  let previous: string | undefined;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each read depends on the acknowledgements before it
    const pending = await queue.pending(stream, BATCH);
    const first = pending[0]?.jti;
    if (first === undefined || first === previous) {
      return;
    }
    previous = first;
    // oxlint-disable-next-line no-await-in-loop -- as above
    await Promise.all(
      pending.map(({ jti }) => Promise.resolve(queue.ack(stream, jti))),
    );
  }
}

/** Pushes the SETs a paused push stream held, oldest first, until one may be retried. */
async function flush(
  queue: SetQueue,
  configuration: SsfStreamConfiguration,
  fetchFn: typeof fetch | undefined,
): Promise<void> {
  const { stream_id: stream, delivery } = configuration;
  if (delivery.endpoint_url === undefined) {
    return;
  }
  let previous: string | undefined;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- SETs are pushed in order
    const pending = await queue.pending(stream, BATCH);
    const first = pending[0]?.jti;
    if (first === undefined || first === previous) {
      return;
    }
    previous = first;
    for (const { jti, set } of pending) {
      // oxlint-disable-next-line no-await-in-loop -- as above
      const result = await pushSet(
        set,
        compact({
          endpoint: delivery.endpoint_url,
          authorization: delivery.authorization_header,
          fetch: fetchFn,
        }),
      );
      if (result.ok) {
        // oxlint-disable-next-line no-await-in-loop -- as above
        await queue.ack(stream, jti);
      } else if (result.retry) {
        return;
      } else {
        // oxlint-disable-next-line no-await-in-loop -- as above
        await queue.fail(stream, jti, {
          err: result.cause.replaceAll("-", "_"),
          description: result.description ?? result.cause,
        });
      }
    }
  }
}

async function deliver(
  stream: SsfStream,
  status: SsfStreamStatus["status"],
  jti: string,
  set: string,
  options: FanOutSetOptions,
): Promise<SsfFanOut> {
  const { stream_id: id, delivery } = stream.configuration;
  if (
    delivery.method === SSF_POLL_DELIVERY ||
    status === "paused" ||
    delivery.endpoint_url === undefined
  ) {
    await options.queue.enqueue(id, jti, set);
    return { stream: id, jti, queued: true, delivery: { ok: true } };
  }
  const result = await pushSet(
    set,
    compact({
      endpoint: delivery.endpoint_url,
      authorization: delivery.authorization_header,
      fetch: options.fetch,
    }),
  );
  return { stream: id, jti, queued: false, delivery: result };
}

/**
 * Signs `event` once per distinct stream audience and delivers it to every
 * stream that is not disabled and has the event in `events_delivered`: a
 * push stream through `pushSet`, a poll stream or a paused stream into the
 * queue. Answers one row per stream that took the event.
 */
export async function fanOutSet(
  event: SetEvent,
  options: FanOutSetOptions,
): Promise<readonly SsfFanOut[]> {
  const groups = new Map<
    string,
    {
      readonly audience: string | readonly string[];
      readonly targets: {
        readonly stream: SsfStream;
        readonly status: SsfStreamStatus["status"];
      }[];
    }
  >();
  for (const stream of await options.streams.list()) {
    const { configuration } = stream;
    // oxlint-disable-next-line no-await-in-loop -- one status read per stream, in list order
    const status = (await options.streams.status(configuration.stream_id))
      ?.status;
    const delivered =
      configuration.events_delivered ?? configuration.events_requested ?? [];
    if (
      status === undefined ||
      status === "disabled" ||
      !delivered.includes(event.type)
    ) {
      continue;
    }
    const key = JSON.stringify(configuration.aud);
    const group = groups.get(key) ?? {
      audience: configuration.aud,
      targets: [],
    };
    group.targets.push({ stream, status });
    groups.set(key, group);
  }
  const rows = await Promise.all(
    [...groups.values()].map(async ({ audience, targets }) => {
      const jti = globalThis.crypto.randomUUID();
      const set = await signSet(event, options.signer, { audience, jti });
      return Promise.all(
        targets.map(({ stream, status }) =>
          deliver(stream, status, jti, set, options),
        ),
      );
    }),
  );
  return rows.flat();
}

/**
 * An SSF 1.0 transmitter as one Fetch handler, routed by path suffix:
 * `/.well-known/ssf-configuration` (section 7.1), `/stream` (8.1.1),
 * `/status` (8.1.2), `/verify` (8.1.4) and `/poll` (RFC 8936). Each receiver
 * sees only the streams it created. Disabling or deleting a stream drops its
 * pending SETs; a paused stream holds them until it is enabled again.
 */
export function ssfTransmitter(
  options: SsfTransmitterOptions,
): (request: Request) => Promise<Response> {
  const base = (options.endpoint ?? options.issuer).replace(/\/+$/u, "");
  const supported = options.eventsSupported ?? knownEventTypes();
  const audienceOf =
    options.audience ?? ((receiver: string): string => receiver);
  const cap = options.maxEvents ?? 100;
  const { streams, queue } = options;

  const metadata: SsfTransmitterConfiguration = compact({
    spec_version: "1_0",
    issuer: options.issuer,
    jwks_uri: options.jwksUri,
    delivery_methods_supported: [SSF_PUSH_DELIVERY, SSF_POLL_DELIVERY],
    configuration_endpoint: `${base}/stream`,
    status_endpoint: `${base}/status`,
    verification_endpoint: `${base}/verify`,
    authorization_schemes: [{ spec_urn: "urn:ietf:rfc:6750" }],
    default_subjects: "ALL",
  });

  const configurationOf = (
    id: string,
    owner: string,
    properties: ReceiverProperties,
  ): SsfStreamConfiguration =>
    compact<SsfStreamConfiguration>({
      stream_id: id,
      iss: options.issuer,
      aud: audienceOf(owner),
      events_supported: supported,
      events_requested: properties.events_requested,
      events_delivered: properties.events_requested.filter((event) =>
        supported.includes(event),
      ),
      delivery:
        properties.delivery.method === SSF_POLL_DELIVERY
          ? {
              method: SSF_POLL_DELIVERY,
              endpoint_url: `${base}/poll?stream_id=${encodeURIComponent(id)}`,
            }
          : properties.delivery,
      description: properties.description,
    });

  const stream = async (
    request: Request,
    url: URL,
    owner: string,
  ): Promise<Response> => {
    switch (request.method) {
      case "GET": {
        const id = url.searchParams.get("stream_id");
        if (id === null) {
          const listed = await streams.list(owner);
          return jsonResponse(
            200,
            listed.map((entry) => entry.configuration),
          );
        }
        const found = await owned(streams, id, owner);
        return found instanceof Response
          ? found
          : jsonResponse(200, found.configuration);
      }
      case "POST": {
        const body = await readBody(request);
        if (body instanceof Response) {
          return body;
        }
        const properties = readProperties(body);
        if (typeof properties === "string") {
          return validationProblem(properties);
        }
        const configuration = configurationOf(
          globalThis.crypto.randomUUID(),
          owner,
          properties,
        );
        await streams.create(owner, configuration);
        return jsonResponse(201, configuration);
      }
      case "PATCH":
      case "PUT": {
        const body = await readBody(request);
        if (body instanceof Response) {
          return body;
        }
        const found = await owned(streams, body["stream_id"], owner);
        if (found instanceof Response) {
          return found;
        }
        const properties = readProperties(
          body,
          request.method === "PATCH"
            ? propertiesOf(found.configuration)
            : undefined,
        );
        if (typeof properties === "string") {
          return validationProblem(properties);
        }
        const configuration = configurationOf(
          found.configuration.stream_id,
          owner,
          properties,
        );
        await streams.update(configuration);
        return jsonResponse(200, configuration);
      }
      case "DELETE": {
        const found = await owned(
          streams,
          url.searchParams.get("stream_id"),
          owner,
        );
        if (found instanceof Response) {
          return found;
        }
        await streams.delete(found.configuration.stream_id);
        await drain(queue, found.configuration.stream_id);
        return new Response(null, { status: 204 });
      }
      default:
        return methodNotAllowed("GET, POST, PATCH, PUT, DELETE");
    }
  };

  const statusOf = async (id: string): Promise<SsfStreamStatus> =>
    (await streams.status(id)) ?? { stream_id: id, status: "enabled" };

  const status = async (
    request: Request,
    url: URL,
    owner: string,
  ): Promise<Response> => {
    if (request.method === "GET") {
      const found = await owned(
        streams,
        url.searchParams.get("stream_id"),
        owner,
      );
      return found instanceof Response
        ? found
        : jsonResponse(200, await statusOf(found.configuration.stream_id));
    }
    if (request.method !== "POST") {
      return methodNotAllowed("GET, POST");
    }
    const body = await readBody(request);
    if (body instanceof Response) {
      return body;
    }
    const found = await owned(streams, body["stream_id"], owner);
    if (found instanceof Response) {
      return found;
    }
    const next = body["status"];
    const reason = body["reason"];
    if (!isStatus(next)) {
      return validationProblem(`status must be one of ${STATUSES.join(", ")}`);
    }
    if (reason !== undefined && typeof reason !== "string") {
      return validationProblem("reason must be a string");
    }
    const id = found.configuration.stream_id;
    const before = await statusOf(id);
    const updated = compact<SsfStreamStatus>({
      stream_id: id,
      status: next,
      reason,
    });
    await streams.setStatus(updated);
    if (next === "disabled") {
      await drain(queue, id);
    } else if (
      next === "enabled" &&
      before.status === "paused" &&
      found.configuration.delivery.method === SSF_PUSH_DELIVERY
    ) {
      await flush(queue, found.configuration, options.fetch);
    }
    return jsonResponse(200, updated);
  };

  const verify = async (request: Request, owner: string): Promise<Response> => {
    if (request.method !== "POST") {
      return methodNotAllowed("POST");
    }
    const body = await readBody(request);
    if (body instanceof Response) {
      return body;
    }
    const found = await owned(streams, body["stream_id"], owner);
    if (found instanceof Response) {
      return found;
    }
    const state = body["state"];
    if (state !== undefined && typeof state !== "string") {
      return validationProblem("state must be a string");
    }
    const { configuration } = found;
    const current = await statusOf(configuration.stream_id);
    if (current.status === "disabled") {
      return problemResponse(statusProblem(409, "stream is disabled"));
    }
    const jti = globalThis.crypto.randomUUID();
    const set = await signSet(
      streamVerificationEvent(configuration.stream_id, state),
      options.signer,
      { audience: configuration.aud, jti },
    );
    await deliver(found, current.status, jti, set, options);
    return new Response(null, { status: 204 });
  };

  const poll = async (
    request: Request,
    url: URL,
    owner: string,
  ): Promise<Response> => {
    const id = url.searchParams.get("stream_id");
    const found = id === null ? null : await streams.get(id);
    if (
      found?.owner !== owner ||
      found.configuration.delivery.method !== SSF_POLL_DELIVERY
    ) {
      return notFoundProblem();
    }
    const current = await statusOf(found.configuration.stream_id);
    return setPollHandler({
      queue,
      authorize: () => found.configuration.stream_id,
      maxEvents: current.status === "enabled" ? cap : 0,
    })(request);
  };

  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/u, "");
    if (path.endsWith("/.well-known/ssf-configuration")) {
      return request.method === "GET"
        ? jsonResponse(200, metadata)
        : methodNotAllowed("GET");
    }
    let owner: string | null;
    try {
      owner = await options.authorize(request);
    } catch {
      owner = null;
    }
    if (owner === null) {
      return problemResponse(
        statusProblem(401, "stream management not authorized"),
        undefined,
        undefined,
        { "WWW-Authenticate": "Bearer" },
      );
    }
    if (path.endsWith("/stream")) {
      return stream(request, url, owner);
    }
    if (path.endsWith("/status")) {
      return status(request, url, owner);
    }
    if (path.endsWith("/verify")) {
      return verify(request, owner);
    }
    if (path.endsWith("/poll")) {
      return poll(request, url, owner);
    }
    return notFoundProblem();
  };
}
