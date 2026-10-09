import type { Server } from "node:http";

import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { createPermDock } from "../../src/express/index.ts";
import { memberUser, permissions, policy } from "../fixtures/quick-start.ts";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function listen(
  app: ReturnType<typeof express>,
): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
  const server = await new Promise<Server>((resolve) => {
    const next = app.listen(0, "127.0.0.1", () => {
      resolve(next);
    });
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected tcp address");
  }
  const base = `http://127.0.0.1:${String(address.port)}`;
  return (path, init) => fetch(`${base}${path}`, init);
}

describe("permdock/express edge cases", () => {
  it("protects a collection route without a loader", async () => {
    const { protect, withPermDock } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = express();
    app.get(
      "/posts",
      protect(permissions.post.list),
      withPermDock((req, res) => {
        res.json({ data: req.permdockData ?? null });
      }),
    );
    const request = await listen(app);
    const response = await request("/posts");
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { data: null },
    });
  });

  it("serves the snapshot on GET from the evaluations handler", async () => {
    const { permdockHandler } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = express();
    app.use("/api/permdock", permdockHandler());
    const request = await listen(app);
    const response = await request("/api/permdock");
    expect(response.status).toBe(200);
  });
});

describe("permdock/express subject reuse", () => {
  it("resolves the subject once when permdock() runs before the decision endpoint", async () => {
    let resolved = 0;
    const { permdock, permdockHandler } = createPermDock(policy, {
      subject: () => {
        resolved += 1;
        return memberUser;
      },
    });
    const app = express();
    app.use(permdock());
    app.use(express.json());
    app.use("/api/permdock", permdockHandler());
    const request = await listen(app);
    const response = await request("/api/permdock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        evaluations: [{ action: { name: "post.list" } }],
      }),
    });
    expect(await response.json()).toEqual({
      evaluations: [expect.objectContaining({ decision: true })],
    });
    expect(resolved).toBe(1);
  });
});
