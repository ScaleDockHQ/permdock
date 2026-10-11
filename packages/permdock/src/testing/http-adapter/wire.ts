import type { HttpCall, HttpResult } from "./domain.ts";

import { APPROVAL_HEADER } from "../../approvals/index.ts";

export function restRequest(base: string, call: HttpCall): Request {
  const headers = new Headers();
  if (call.authorization !== null) {
    headers.set("authorization", call.authorization);
  }
  if (call.approval !== undefined) {
    headers.set(APPROVAL_HEADER, call.approval);
  }
  const json = (method: string, path: string, body: unknown): Request => {
    headers.set("content-type", "application/json");
    return new Request(`${base}${path}`, {
      method,
      headers,
      body: JSON.stringify(body),
    });
  };
  const plain = (method: string, path: string): Request =>
    new Request(`${base}${path}`, { method, headers });
  switch (call.op) {
    case "project.get":
      return plain("GET", `/${call.org}/projects/${call.id}`);
    case "project.update":
      return json("PATCH", `/${call.org}/projects/${call.id}`, {
        name: "Renamed",
      });
    case "project.create":
      return json("POST", `/${call.org}/projects`, call.body);
    case "project.delete":
      return plain("DELETE", `/${call.org}/projects/${call.id}`);
    case "project.upload": {
      const form = new FormData();
      form.set("file", new Blob([call.file.content]), call.file.name);
      return new Request(`${base}/${call.org}/projects/${call.id}/files`, {
        method: "POST",
        headers,
        body: form,
      });
    }
    case "analytics.read":
      return plain("GET", `/${call.org}/analytics`);
    case "apiKey.create":
      return plain("POST", `/${call.org}/api-keys`);
    case "apiKey.revokeAll":
      return plain("POST", `/${call.org}/api-keys/revoke-all`);
    case "admin.members":
      return plain("GET", `/${call.org}/admin/members`);
    case "evaluations":
      return json(
        "POST",
        `/${call.org}/permdock/access/v1/evaluations`,
        call.body,
      );
    default: {
      const exhaustive: never = call;
      return exhaustive;
    }
  }
}

export async function readResult(response: Response): Promise<HttpResult> {
  const text = await response.text();
  if (text.length === 0) {
    return { status: response.status, body: null };
  }
  try {
    const body: unknown = JSON.parse(text);
    return { status: response.status, body };
  } catch {
    return { status: response.status, body: text };
  }
}

export function field(body: unknown, key: string): unknown {
  // SAFETY: body was checked to be a non-null object; the field stays unknown.
  return body !== null && typeof body === "object"
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

export function reasonsOf(body: unknown): readonly unknown[] {
  const denials = field(body, "denials");
  return Array.isArray(denials)
    ? denials.map((denial: unknown) => field(denial, "reason"))
    : [];
}

export const PARALLEL: readonly {
  readonly user: string | null;
  readonly org: string;
  readonly id: string;
  readonly status: number;
}[] = [
  { user: "alice", org: "acme", id: "p1", status: 200 },
  { user: "alice", org: "globex", id: "g1", status: 200 },
  { user: "alice", org: "acme", id: "g1", status: 403 },
  { user: "bob", org: "acme", id: "p1", status: 200 },
  { user: "bob", org: "globex", id: "g1", status: 403 },
  { user: "hank", org: "acme", id: "p3", status: 200 },
  { user: "mallory", org: "acme", id: "p1", status: 403 },
  { user: null, org: "acme", id: "p1", status: 401 },
  { user: "erin", org: "globex", id: "g1", status: 200 },
  { user: "frank", org: "acme", id: "p1", status: 403 },
];

type Frame = { readonly event: string; readonly data: string };

export type EventStream = {
  readonly status: number;
  /** The next frame, or `undefined` once the server ended the stream. */
  readonly next: () => Promise<Frame | undefined>;
  readonly cancel: () => Promise<void>;
};

const STREAM_WAIT_MS = 4000;

async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${what}`));
    }, STREAM_WAIT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function parseFrame(raw: string): Frame | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }
  return data.length === 0 ? undefined : { event, data: data.join("\n") };
}

export function eventStream(response: Response): EventStream {
  const reader = response.body
    ?.pipeThrough(new TextDecoderStream())
    .getReader();
  let buffer = "";
  const next = async (): Promise<Frame | undefined> => {
    if (reader === undefined) {
      return undefined;
    }
    for (;;) {
      const end = /\r?\n\r?\n/u.exec(buffer);
      if (end !== null) {
        const frame = parseFrame(buffer.slice(0, end.index));
        buffer = buffer.slice(end.index + end[0].length);
        if (frame !== undefined) {
          return frame;
        }
        continue;
      }
      const chunk = await within(reader.read(), "an SSE frame");
      if (chunk.done) {
        return undefined;
      }
      buffer += chunk.value;
    }
  };
  return {
    status: response.status,
    next,
    cancel: async () => {
      await reader?.cancel().catch(() => undefined);
    },
  };
}

/** Reads frames until the `permdock` frame and the end of the stream. */
export async function untilEnd(
  stream: EventStream,
): Promise<{ readonly problem: unknown; readonly ended: boolean }> {
  for (;;) {
    const frame = await stream.next();
    if (frame === undefined) {
      return { problem: undefined, ended: true };
    }
    if (frame.event === "permdock") {
      const problem: unknown = JSON.parse(frame.data);
      return { problem, ended: (await stream.next()) === undefined };
    }
  }
}
