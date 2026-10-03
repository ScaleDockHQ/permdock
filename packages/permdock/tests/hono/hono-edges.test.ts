import type { SSEMessage, SSEStreamingApi } from "hono/streaming";
import type { WSContext } from "hono/ws";

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { PermDockEnv } from "../../src/hono/index.ts";
import type { Connection } from "../../src/server/connection.ts";

import { memoryRevocationFeed } from "../../src/core/revocations.ts";
import { createPermDock } from "../../src/hono/index.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

function fakeStream(aborted = false): {
  readonly stream: SSEStreamingApi;
  readonly frames: SSEMessage[];
} {
  const frames: SSEMessage[] = [];
  const stream = {
    aborted,
    onAbort: () => undefined,
    writeSSE: async (message: SSEMessage) => {
      frames.push(message);
    },
  };
  // SAFETY: sse reads only aborted, onAbort and writeSSE.
  return { stream: stream as unknown as SSEStreamingApi, frames };
}

async function withConnection<T>(
  use: (conn: Connection) => Promise<T>,
  revocations = memoryRevocationFeed(),
): Promise<T> {
  const { connection } = createPermDock(policy, {
    subject: () => memberUser,
    revocations,
  });
  let result: T | undefined;
  const app = new Hono();
  app.get("/", async (c) => {
    result = await use(await connection(c));
    return c.text("done");
  });
  await app.request("/");
  // SAFETY: the route above always assigns result before it answers.
  return result as T;
}

describe("permdock/hono sse", () => {
  it("writes the default JSON frame and rethrows a source error", async () => {
    const { stream, frames } = fakeStream();
    const failure = new Error("source failed");
    const outcome = await withConnection(async (conn) => {
      async function* source(): AsyncGenerator<{ readonly n: number }> {
        yield { n: 1 };
        throw failure;
      }
      const { sse } = createPermDock(policy, { subject: () => memberUser });
      return sse(conn, stream, source()).then(
        () => "resolved",
        (error: unknown) => error,
      );
    });
    expect({ outcome, frames }).toEqual({
      outcome: failure,
      frames: [{ data: '{"n":1}' }],
    });
  });

  it("stops at once on an aborted stream and skips the revocation frame", async () => {
    const revocations = memoryRevocationFeed();
    const { stream, frames } = fakeStream(true);
    await withConnection(async (conn) => {
      const { sse } = createPermDock(policy, { subject: () => memberUser });
      async function* source(): AsyncGenerator<typeof ownPost> {
        yield ownPost;
      }
      await sse(conn, stream, source());
      await revocations.revoke({ principal: "u1", kind: "session-revoked" });
      async function* after(): AsyncGenerator<typeof ownPost> {
        yield ownPost;
      }
      await sse(conn, stream, after(), { unwrap: (item) => item });
    }, revocations);
    expect(frames).toEqual([]);
  });

  it("skips the revocation frame when the client left meanwhile", async () => {
    const revocations = memoryRevocationFeed();
    const frames: SSEMessage[] = [];
    const state = { aborted: false };
    const stream = {
      get aborted() {
        return state.aborted;
      },
      onAbort: () => undefined,
      writeSSE: async (message: SSEMessage) => {
        frames.push(message);
      },
    };
    await withConnection(async (conn) => {
      const { sse } = createPermDock(policy, { subject: () => memberUser });
      async function* source(): AsyncGenerator<typeof ownPost> {
        yield ownPost;
        await revocations.revoke({ principal: "u1", kind: "session-revoked" });
        state.aborted = true;
        yield ownPost;
      }
      // SAFETY: sse reads only aborted, onAbort and writeSSE.
      await sse(conn, stream as unknown as SSEStreamingApi, source());
    }, revocations);
    expect(frames).toEqual([{ data: JSON.stringify(ownPost) }]);
  });
});

describe("permdock/hono sockets", () => {
  it("skips onOpen for an aborted connection and closes on onClose", async () => {
    const revocations = memoryRevocationFeed();
    const { socket } = createPermDock(policy, { subject: () => memberUser });
    const calls: string[] = [];
    await withConnection(async (conn) => {
      await revocations.revoke({ principal: "u1", kind: "session-revoked" });
      const events = socket(conn, {
        onOpen: () => {
          calls.push("open");
        },
        onClose: () => {
          calls.push("close");
        },
      });
      // SAFETY: the socket handlers call only close() on the WSContext, which this stub provides.
      const ws = { close: () => undefined } as unknown as WSContext;
      events.onOpen?.(new Event("open"), ws);
      events.onClose?.(new CloseEvent("close"), ws);
      const bare = socket(conn, {});
      bare.onOpen?.(new Event("open"), ws);
      bare.onClose?.(new CloseEvent("close"), ws);
      return conn.signal.aborted;
    }, revocations);
    expect(calls).toEqual(["close"]);
  });
});

describe("permdock/hono middleware", () => {
  it("maps a downstream denial and leaves other errors to Hono", async () => {
    const { permdock } = createPermDock(policy, { subject: () => memberUser });
    const app = new Hono<PermDockEnv>();
    app.use(permdock());
    app.get("/denied", (c) => {
      c.var.permdock.assert(permissions.post.update, otherPost);
      return c.text("ok");
    });
    app.get("/boom", () => {
      throw new Error("boom");
    });
    app.get("/fine", (c) => c.text("ok"));
    const denied = await app.request("/denied");
    const boom = await app.request("/boom");
    const fine = await app.request("/fine");
    expect([denied.status, boom.status, fine.status]).toEqual([403, 500, 200]);
  });

  it("rethrows a build failure that is not a signature error", async () => {
    const { permdock } = createPermDock(policy, {
      subject: () => memberUser,
      pdp: async () => {
        throw new Error("pdp factory failed");
      },
    });
    const app = new Hono();
    app.use(permdock());
    app.get("/", (c) => c.text("reached"));
    const response = await app.request("/");
    expect(response.status).toBe(500);
  });

  it("protects a collection without a loader and serves the snapshot on GET", async () => {
    const { protect, permdockHandler } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = new Hono();
    app.get("/posts", protect(permissions.post.list), (c) =>
      c.text(c.var.permdock.subject.principal?.id ?? "none"),
    );
    app.route("/api/permdock", permdockHandler());
    const posts = await app.request("/posts");
    const snapshot = await app.request("/api/permdock");
    expect({ posts: await posts.text(), snapshot: snapshot.status }).toEqual({
      posts: "u1",
      snapshot: 200,
    });
  });
});
