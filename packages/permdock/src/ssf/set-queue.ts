import type { SetError, SetPollHandlerOptions, SetQueue } from "./types.ts";

import { isRecord } from "../core/compact.ts";
import { readBodyText } from "../server/body-text.ts";
import { rfc8935, jsonResponse } from "./wire.ts";

/**
 * The largest poll request body read: acknowledgements and errors for many
 * SETs.
 */
const MAX_POLL_BYTES = 262_144;
const DEFAULT_MAX_EVENTS = 100;

/**
 * An in-process `SetQueue`: pending SETs per stream in insertion order. A
 * process restart loses them; a deployment with more than one instance needs a
 * shared queue.
 */
export function memorySetQueue(): SetQueue {
  const streams = new Map<string, Map<string, string>>();
  const of = (stream: string): Map<string, string> => {
    let queue = streams.get(stream);
    if (queue === undefined) {
      queue = new Map();
      streams.set(stream, queue);
    }
    return queue;
  };
  return Object.freeze({
    name: "memory",
    enqueue(stream: string, jti: string, set: string): void {
      of(stream).set(jti, set);
    },
    pending(stream: string, max: number) {
      return [...of(stream)]
        .slice(0, Math.max(0, max))
        .map(([jti, set]) => ({ jti, set }));
    },
    ack(stream: string, jti: string): void {
      of(stream).delete(jti);
    },
    fail(stream: string, jti: string, _error: SetError): void {
      of(stream).delete(jti);
    },
  });
}

type PollRequest = {
  readonly maxEvents?: number;
  readonly acks: readonly string[];
  readonly setErrs: readonly (readonly [string, SetError])[];
};

function setErrors(
  value: unknown,
): readonly (readonly [string, SetError])[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const out: (readonly [string, SetError])[] = [];
  for (const [jti, entry] of Object.entries(value)) {
    if (
      !isRecord(entry) ||
      typeof entry["err"] !== "string" ||
      typeof entry["description"] !== "string"
    ) {
      return undefined;
    }
    out.push([jti, { err: entry["err"], description: entry["description"] }]);
  }
  return out;
}

function parsePollRequest(text: string): PollRequest | undefined {
  let parsed: unknown;
  try {
    parsed = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const { maxEvents, acks = [] } = parsed;
  const setErrs = setErrors(parsed["setErrs"]);
  if (
    (maxEvents !== undefined &&
      !(Number.isSafeInteger(maxEvents) && Number(maxEvents) >= 0)) ||
    !Array.isArray(acks) ||
    !acks.every((jti) => typeof jti === "string") ||
    setErrs === undefined
  ) {
    return undefined;
  }
  return {
    ...(maxEvents === undefined ? {} : { maxEvents: Number(maxEvents) }),
    acks: acks.map(String),
    setErrs,
  };
}

/**
 * The RFC 8936 poll endpoint over a `SetQueue`. It applies the request's `acks`
 * and `setErrs`, then answers `{ sets, moreAvailable }` with up to `maxEvents`
 * pending SETs. It answers at once whatever `returnImmediately` says, which RFC
 * 8936 section 2.4 allows.
 */
export function setPollHandler(
  options: SetPollHandlerOptions,
): (request: Request) => Promise<Response> {
  const cap = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  return async (request) => {
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    let stream: string | null;
    try {
      stream = await options.authorize(request);
    } catch {
      stream = null;
    }
    if (stream === null) {
      return rfc8935(401, "authentication_failed", "poll not authorized");
    }
    const read = await readBodyText(request, MAX_POLL_BYTES);
    const body = read.ok ? parsePollRequest(read.text) : undefined;
    if (body === undefined) {
      return rfc8935(400, "invalid_request", "malformed poll request");
    }
    const { queue } = options;
    for (const jti of body.acks) {
      // oxlint-disable-next-line no-await-in-loop -- a queue may need acknowledgements applied in order
      await queue.ack(stream, jti);
    }
    for (const [jti, error] of body.setErrs) {
      // oxlint-disable-next-line no-await-in-loop -- as above
      await queue.fail(stream, jti, error);
    }
    const max = Math.min(body.maxEvents ?? cap, cap);
    if (max === 0) {
      return jsonResponse(200, { sets: {} });
    }
    const pending = await queue.pending(stream, max + 1);
    const sets: Record<string, string> = {};
    for (const { jti, set } of pending.slice(0, max)) {
      sets[jti] = set;
    }
    return jsonResponse(200, {
      sets,
      ...(pending.length > max ? { moreAvailable: true } : {}),
    });
  };
}
