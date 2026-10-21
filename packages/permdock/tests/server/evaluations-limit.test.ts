import { describe, expect, it } from "vitest";

import { getPermDockSync as createCorePermDock } from "../../src/core/permdock.ts";
import { evaluationsHandler } from "../../src/server/index.ts";
import { memberUser, policy } from "../fixtures/quick-start.ts";

function batch(size: number): Request {
  return new Request("https://api.example/access/v1/evaluations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      evaluations: Array.from({ length: size }, () => ({
        action: { name: "post.read" },
        resource: { type: "post", id: "p1" },
      })),
    }),
  });
}

describe("evaluationsHandler batch limit", () => {
  it("answers an oversized batch with 413 before resolving an instance", async () => {
    let resolved = 0;
    const handler = evaluationsHandler({
      policy,
      maxEvaluations: 2,
      resolve: async () => {
        resolved += 1;
        return createCorePermDock(policy, memberUser);
      },
    });
    const response = await handler.POST(batch(3));
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(resolved).toBe(0);
    const { status } = await handler.POST(batch(2));
    expect(status).toBe(200);
    expect(resolved).toBe(1);
  });

  it("answers a body over 1 MiB with 413 before resolving an instance", async () => {
    let resolved = 0;
    const handler = evaluationsHandler({
      policy,
      resolve: async () => {
        resolved += 1;
        return createCorePermDock(policy, memberUser);
      },
    });
    const body = JSON.stringify({
      evaluations: [],
      pad: "x".repeat(1_048_576),
    });
    const response = await handler.POST(
      new Request("https://api.example/access/v1/evaluations", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "2" },
        body,
      }),
    );
    expect(response.status).toBe(413);
    expect(resolved).toBe(0);
  });

  it("defaults to the AuthZEN limit of 256", async () => {
    const handler = evaluationsHandler({
      policy,
      resolve: async () => createCorePermDock(policy, memberUser),
    });
    const { status } = await handler.POST(batch(257));
    expect(status).toBe(413);
    expect((await handler.POST(batch(256))).status).toBe(200);
  });
});
