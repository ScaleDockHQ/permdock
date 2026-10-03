import { afterEach, describe, expect, it, vi } from "vitest";

import type { Subject } from "../../src/core/subject.ts";

import { PermDockRevokedError } from "../../src/core/errors.ts";
import { memoryRevocationFeed } from "../../src/core/revocations.ts";
import { createPermDock } from "../../src/server/index.ts";
import {
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

type Session = {
  roles: string[];
  id: string | null;
  session?: string;
  expiresAt?: number;
  memberships?: { tenant: string; roles: string[]; expiresAt: number }[];
};

function setup(state: Session, extra: { revalidate?: number } = {}) {
  const revocations = memoryRevocationFeed();
  let reads = 0;
  const kernel = createPermDock(policy, {
    revocations,
    subject: (): Subject | null => {
      reads += 1;
      if (state.id === null) {
        return null;
      }
      return {
        principal: {
          id: state.id,
          orgId: "o1",
          roles: [...state.roles],
          ...(state.memberships === undefined
            ? {}
            : { memberships: state.memberships }),
        },
        context: {},
        ...(state.session === undefined ? {} : { session: state.session }),
        ...(state.expiresAt === undefined
          ? {}
          : { expiresAt: state.expiresAt }),
      };
    },
  });
  const open = (
    permission:
      | typeof permissions.post.list
      | typeof permissions.post.publish = permissions.post.list,
  ) =>
    kernel.connection(new Request("https://api.example/stream"), {
      permission,
      ...extra,
    });
  return { kernel, revocations, open, reads: () => reads };
}

function reasonOf(signal: AbortSignal): PermDockRevokedError {
  expect(signal.aborted).toBe(true);
  expect(signal.reason).toBeInstanceOf(PermDockRevokedError);
  // SAFETY: toBeInstanceOf above checked the reason is a PermDockRevokedError.
  return signal.reason as PermDockRevokedError;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("kernel connection", () => {
  it("checks each message and filters outbound items against the current instance", async () => {
    const { open } = setup({ id: "u1", roles: ["member"] });
    const conn = await open();
    expect(conn.signal.aborted).toBe(false);
    expect(conn.check(permissions.post.update, ownPost).outcome).toBe(
      "granted",
    );
    expect(conn.check(permissions.post.update, otherPost).outcome).toBe(
      "denied",
    );
    expect(conn.filter(permissions.post.update, [ownPost, otherPost])).toEqual([
      ownPost,
    ]);
    expect(conn.signal.aborted).toBe(false);
    conn.close();
  });

  it("aborts at open when the opening permission is denied", async () => {
    const { open } = setup({ id: "u1", roles: ["member"] });
    const conn = await open(permissions.post.publish);
    const reason = reasonOf(conn.signal);
    expect(reason.code).toBe("denied");
    expect(reason.decision?.outcome).toBe("denied");
    expect(reason.toProblemDetails().status).toBe(403);
    expect(conn.check(permissions.post.read, ownPost)).toMatchObject({
      outcome: "denied",
      denials: [{ reason: "no-grant", detail: "connection-revoked" }],
    });
  });

  it("aborts on session-revoked for its principal and session only", async () => {
    const { open, revocations } = setup({
      id: "u1",
      roles: ["member"],
      session: "s1",
    });
    const conn = await open();
    await revocations.revoke({ principal: "u2", kind: "session-revoked" });
    await revocations.revoke({
      principal: "u1",
      session: "s2",
      kind: "session-revoked",
    });
    expect(conn.signal.aborted).toBe(false);
    await revocations.revoke({
      principal: "u1",
      session: "s1",
      kind: "session-revoked",
    });
    expect(reasonOf(conn.signal).code).toBe("session-revoked");
    expect(reasonOf(conn.signal).toProblemDetails().status).toBe(401);
    expect(conn.filter(permissions.post.update, [ownPost])).toEqual([]);
  });

  it("revalidates on changed: keeps a still-granted connection and swaps the instance", async () => {
    const state: Session = { id: "u2", roles: ["admin"] };
    const { open, revocations, reads } = setup(state);
    const conn = await open(permissions.post.list);
    const before = conn.permdock;
    expect(conn.check(permissions.post.publish, ownPost).outcome).toBe(
      "granted",
    );
    state.roles = ["member"];
    await revocations.revoke({ principal: "u2", kind: "changed" });
    await settle();
    expect(reads()).toBe(2);
    expect(conn.signal.aborted).toBe(false);
    expect(conn.permdock).not.toBe(before);
    expect(conn.check(permissions.post.publish, ownPost).outcome).toBe(
      "denied",
    );
  });

  it("aborts with denied when a demotion removes the opening permission", async () => {
    const state: Session = { id: "u2", roles: ["admin"] };
    const { open, revocations } = setup(state);
    const conn = await open(permissions.post.publish);
    state.roles = ["member"];
    await revocations.revoke({ principal: "u2", kind: "changed" });
    await settle();
    expect(reasonOf(conn.signal).code).toBe("denied");
  });

  it("aborts with subject-changed when the subject no longer resolves", async () => {
    const state: Session = { id: "u1", roles: ["member"] };
    const { open, revocations } = setup(state);
    const conn = await open();
    state.id = null;
    await revocations.revoke({ principal: "u1", kind: "changed" });
    await settle();
    expect(reasonOf(conn.signal).code).toBe("subject-changed");
  });

  it("aborts with expired at subject.expiresAt", async () => {
    vi.useFakeTimers();
    const now = Date.now() / 1000;
    const { open } = setup({
      id: "u1",
      roles: ["member"],
      expiresAt: now + 10,
    });
    const conn = await open();
    vi.advanceTimersByTime(9_000);
    expect(conn.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1_500);
    expect(reasonOf(conn.signal).code).toBe("expired");
  });

  it("revalidates at the earliest membership expiry and on the revalidate interval", async () => {
    vi.useFakeTimers();
    const now = Date.now() / 1000;
    const membership = setup({
      id: "u1",
      roles: ["member"],
      memberships: [{ tenant: "o1", roles: ["member"], expiresAt: now + 5 }],
    });
    await membership.open();
    expect(membership.reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(membership.reads()).toBe(2);

    const periodic = setup(
      { id: "u1", roles: ["member"] },
      { revalidate: 1_000 },
    );
    const conn = await periodic.open();
    await vi.advanceTimersByTimeAsync(3_100);
    expect(periodic.reads()).toBe(4);
    conn.close();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(periodic.reads()).toBe(4);
  });

  it("stops listening after close and denies later checks", async () => {
    const { open, revocations } = setup({ id: "u1", roles: ["member"] });
    const conn = await open();
    conn.close();
    await revocations.revoke({ principal: "u1", kind: "session-revoked" });
    expect(conn.signal.aborted).toBe(false);
    expect(conn.check(permissions.post.read, ownPost).outcome).toBe("denied");
  });

  it("fails closed when the feed cannot subscribe", async () => {
    const kernel = createPermDock(policy, {
      revocations: {
        subscribe: () => {
          throw new Error("feed down");
        },
        revoke: () => undefined,
      },
      subject: () => ({ id: "u1", orgId: "o1", roles: ["member"] }),
    });
    const conn = await kernel.connection(new Request("https://api.example/"));
    expect(reasonOf(conn.signal).code).toBe("expired");
  });
});

describe("memoryRevocationFeed", () => {
  it("rejects malformed events and isolates a throwing listener", () => {
    const feed = memoryRevocationFeed();
    const seen: string[] = [];
    feed.subscribe(() => {
      throw new Error("listener");
    });
    const stop = feed.subscribe((event) => {
      seen.push(event.principal);
    });
    expect(() => feed.revoke({ principal: "", kind: "changed" })).toThrow(
      TypeError,
    );
    // SAFETY: deliberately unknown revocation kind to exercise input validation.
    expect(() =>
      feed.revoke({ principal: "u1", kind: "grant" as never }),
    ).toThrow(TypeError);
    feed.revoke({ principal: "u1", kind: "changed" });
    stop();
    feed.revoke({ principal: "u2", kind: "changed" });
    expect(seen).toEqual(["u1"]);
  });
});
