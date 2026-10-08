import { describe, expect, it, vi } from "vitest";

import type { Snapshot } from "../../src/core/interfaces.ts";

import {
  cacheLifeFor as nextCacheLifeFor,
  snapshotTag as nextSnapshotTag,
} from "../../src/next/index.ts";
import {
  cacheLifeFor,
  createPermDock,
  snapshotHeaders,
  snapshotTag,
} from "../../src/server/index.ts";
import { alice, policy as saasPolicy } from "../fixtures/saas.ts";

const request = (): Request => new Request("https://app.example/dashboard");

describe("getSnapshot(request)", () => {
  it("builds the snapshot from the request's cached subject", async () => {
    const subject = vi.fn<() => typeof alice>(() => alice);
    const server = createPermDock(saasPolicy, { subject, tenant: "acme" });
    const req = request();
    await server.permdock(req);
    const snapshot = await server.getSnapshot(req);
    expect(subject).toHaveBeenCalledTimes(1);
    expect(snapshot.subject.principal?.id).toBe(alice.id);
    expect(snapshot.subject.principal?.tenant).toBe("acme");
  });

  it("takes the tenant, include and tenants from the query", async () => {
    const server = createPermDock(saasPolicy, { subject: () => alice });
    const snapshot = await server.getSnapshot(request(), {
      tenant: "globex",
      tenants: "all",
    });
    expect(snapshot.subject.principal?.tenant).toBe("globex");
    expect(snapshot.tenants).toEqual(
      expect.arrayContaining(["acme", "globex"]),
    );
  });
});

describe("snapshotHeaders", () => {
  const snapshotAt = async (issuedAt: number): Promise<Snapshot> => {
    const server = createPermDock(saasPolicy, {
      subject: () => alice,
      tenant: "acme",
    });
    return { ...(await server.getSnapshot(request())), issuedAt };
  };

  it("sends a private max-age, Vary, a stable ETag and the subject tag", async () => {
    const first = snapshotHeaders(await snapshotAt(1000), {
      tags: ["org:acme"],
    });
    const second = snapshotHeaders(await snapshotAt(2000));
    expect(first).toMatchObject({
      "Cache-Control": "private, max-age=300",
      Vary: "Authorization, Cookie",
      "Cache-Tag": `${snapshotTag(alice.id)},org:acme`,
    });
    expect(first.ETag).toMatch(/^"[\w-]+"$/);
    expect(second.ETag).toBe(first.ETag);
  });

  it("caps max-age at the seconds left before expiresAt", async () => {
    const snapshot = { ...(await snapshotAt(1000)), expiresAt: 1060 };
    expect(snapshotHeaders(snapshot)["Cache-Control"]).toBe(
      "private, max-age=60",
    );
  });

  it("is the same cacheLifeFor and snapshotTag that permdock/next exports", () => {
    expect(nextCacheLifeFor).toBe(cacheLifeFor);
    expect(nextSnapshotTag).toBe(snapshotTag);
  });
});
