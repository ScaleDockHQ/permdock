import { describe, expect, it } from "vitest";

import type { PermDock } from "../../src/core/permdock.ts";
import type { TanStackStartMiddleware } from "../../src/tanstack-start/index.ts";

import { defineOperations } from "../../src/core/operations.ts";
import { webBotAuthVerifier } from "../../src/server/web-bot-auth.ts";
import { createPermDock } from "../../src/tanstack-start/index.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

const operations = defineOperations(permissions, {
  updatePost: {
    permission: permissions.post.update,
    data: (input: { readonly id: string }) =>
      input.id === ownPost.id ? ownPost : otherPost,
  },
});

type StartServer<TContext> = (options: {
  readonly request: Request;
  readonly pathname: string;
  readonly context: object;
  readonly handlerType: "router";
  readonly next: (options?: {
    readonly context?: TContext;
  }) => Promise<unknown>;
}) => Promise<unknown>;

/**
 * Runs a request middleware the way Start does, with a `next` that records the
 * context it was given.
 */
async function run<TContext>(
  middleware: TanStackStartMiddleware<TContext>,
  request: Request,
  downstream: (context: NoInfer<TContext>) => void = () => undefined,
): Promise<{ readonly response?: Response; readonly context?: TContext }> {
  // SAFETY: Start calls `options.server` with these fields; the test's next returns what Start's would, minus the merged context.
  const server = middleware.options.server as unknown as
    | StartServer<TContext>
    | undefined;
  if (server === undefined) {
    throw new Error("expected a server function");
  }
  let seen: TContext | undefined;
  const result = await server({
    request,
    pathname: new URL(request.url).pathname,
    context: {},
    handlerType: "router",
    next: async (options) => {
      seen = options?.context;
      if (seen !== undefined) {
        downstream(seen);
      }
      return {
        request,
        pathname: "/",
        context: seen,
        response: new Response(),
      };
    },
  });
  return result instanceof Response
    ? { response: result }
    : seen === undefined
      ? {}
      : { context: seen };
}

const request = (path = "/", init?: RequestInit): Request =>
  new Request(`http://localhost${path}`, init);

describe("permdock/tanstack-start", () => {
  it("adds context.permdock in request middleware", async () => {
    const { middleware } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const { context } = await run(middleware(), request());
    expect(context?.permdock.subject.principal?.id).toBe("u1");
  });

  it("answers a bad Web Bot Auth signature before next", async () => {
    const { middleware } = createPermDock(policy, {
      subject: () => memberUser,
      webBotAuth: webBotAuthVerifier({
        verify: true,
        keys: { lookup: () => undefined },
      }),
    });
    const { response, context } = await run(
      middleware(),
      request("/", {
        headers: {
          "Signature-Input":
            'sig1=("@method");created=1700000000;keyid="bot-1";alg="ed25519"',
          Signature: "sig1=:AAAA:",
          "Signature-Agent": '"https://agents.example.com"',
        },
      }),
    );
    expect({ status: response?.status, context }).toStrictEqual({
      status: 403,
      context: undefined,
    });
  });

  it("protects with a permission or an operation and adds the row", async () => {
    const { protect } = createPermDock(policy, { subject: () => memberUser });
    const byPath = protect(permissions.post.update, (req) =>
      new URL(req.url).pathname === "/posts/p1" ? ownPost : otherPost,
    );
    const byOperation = protect(operations.updatePost, (req) => ({
      id: new URL(req.url).pathname.slice("/posts/".length),
    }));
    const own = await run(byPath, request("/posts/p1"));
    const other = await run(byPath, request("/posts/p2"));
    const operation = await run(byOperation, request("/posts/p2"));
    expect(own.context?.permdockData).toStrictEqual(ownPost);
    expect([other.response?.status, operation.response?.status]).toStrictEqual([
      403, 403,
    ]);
  });

  it("maps a denial thrown below the middleware", async () => {
    const { middleware, protect } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const assertDenied = (context: { readonly permdock: PermDock }): void => {
      context.permdock.assert(permissions.post.update, otherPost);
    };
    const viaMiddleware = await run(middleware(), request(), assertDenied);
    const viaProtect = await run(
      protect(permissions.post.read, () => ownPost),
      request(),
      assertDenied,
    );
    expect([
      viaMiddleware.response?.status,
      viaProtect.response?.status,
    ]).toStrictEqual([403, 403]);
  });

  it("serves the decision endpoint, snapshots, instances and connections", async () => {
    const { permdockHandler, getSnapshot, getPermDock, connection } =
      createPermDock(policy, { subject: () => memberUser });
    const { GET, POST } = permdockHandler();
    const get = await GET({ request: request("/api/permdock") });
    const post = await POST({
      request: request("/api/permdock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ evaluations: [] }),
      }),
    });
    const snapshot = await getSnapshot(request());
    const instance = await getPermDock(request());
    const conn = await connection(request());
    expect([get.status, post.status]).toStrictEqual([200, 200]);
    expect(snapshot.v).toBe(1);
    expect(instance.can(permissions.post.read, ownPost)).toBe(true);
    expect(conn.signal.aborted).toBe(false);
  });
});
