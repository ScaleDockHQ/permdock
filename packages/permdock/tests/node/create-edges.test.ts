import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { createPermDock } from "../../src/node/index.ts";
import { memberUser, permissions, policy } from "../fixtures/quick-start.ts";

function get(url: string, method = "GET"): IncomingMessage {
  // SAFETY: the adapter reads only headers, method and url on a GET request.
  return { headers: { host: "api.test" }, method, url } as IncomingMessage;
}

function response(): {
  readonly res: ServerResponse;
  readonly status: () => number;
} {
  const state = { statusCode: 0 };
  const res = {
    get statusCode(): number {
      return state.statusCode;
    },
    set statusCode(value: number) {
      state.statusCode = value;
    },
    setHeader: () => undefined,
    end: () => undefined,
  };
  return {
    // SAFETY: sendResponse uses only statusCode, setHeader and end.
    res: res as unknown as ServerResponse,
    status: () => state.statusCode,
  };
}

describe("permdock/node edge cases", () => {
  it("reuses the bound request and protects a collection without a loader", async () => {
    const { permdock: permdockFor, protect } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const req = get("/posts");
    const permdock = await permdockFor(req);
    const guard = await protect(permissions.post.list)(req);
    expect({
      principal: permdock.subject.principal?.id,
      ok: guard.ok,
    }).toEqual({ principal: "u1", ok: true });
  });

  it("resolves the actor from the incoming message", async () => {
    const { permdock: permdockFor } = createPermDock(policy, {
      subject: () => memberUser,
      actor: (req) => ({ id: String(req.headers.host), kind: "agent" }),
    });
    const permdock = await permdockFor(get("/posts"));
    expect(permdock.subject.actor).toEqual({ id: "api.test", kind: "agent" });
  });

  it("serves the snapshot on GET and HEAD from the evaluations handler", async () => {
    const { permdockHandler } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const handle = permdockHandler();
    const statuses = [];
    for (const method of ["GET", "HEAD"]) {
      const { res, status } = response();
      await handle(get("/api/permdock", method), res);
      statuses.push(status());
    }
    expect(statuses).toEqual([200, 200]);
  });
});
