import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Snapshot } from "../../src/core/interfaces.ts";
import type { PermDockStorage } from "../../src/react-native/types.ts";

import { createPermDock } from "../../src/core/permdock.ts";
import { PermDockProvider } from "../../src/react-native/provider.tsx";
import {
  acceptStored,
  clearStorage,
  guardStorage,
  memoryStorage,
  persistSnapshot,
  readStored,
  readStoredSync,
  SNAPSHOT_KEY,
  TENANT_KEY,
} from "../../src/react-native/storage.ts";
import {
  connectSource,
  createNativeStore,
} from "../../src/react-native/store.ts";
import { usePermission } from "../../src/react/hooks.ts";
import {
  adminUser,
  memberUser,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

async function snapshotOf(user: typeof memberUser): Promise<Snapshot> {
  // SAFETY: user is a quick-start user fixture; only the policy generic is erased.
  const server = await createPermDock(policy as never, user);
  const snapshot = server.snapshot();
  if (snapshot instanceof Promise) {
    throw new Error("expected JSON snapshot");
  }
  // SAFETY: snapshot() without a signer returns a Snapshot; the erased generic hides its type.
  return snapshot as Snapshot;
}

function memberSnapshot(): Promise<Snapshot> {
  return snapshotOf(memberUser);
}

const signedVerifier = (snapshot: Snapshot) => ({
  verify: async () => ({
    ok: true as const,
    claims: { snapshot },
    header: { alg: "ES256" },
  }),
});

describe("permdock/react-native", () => {
  it("answers portable grants from sync storage on the first frame", async () => {
    const snapshot = await memberSnapshot();
    const storage = memoryStorage({
      [SNAPSHOT_KEY]: JSON.stringify(snapshot),
    });
    const html = renderToStaticMarkup(
      <PermDockProvider storage={storage} subjectId="u1">
        <Probe />
      </PermDockProvider>,
    );
    expect(html).toContain("allowed");
  });

  it("discards a persisted snapshot for a different subject or nobody", async () => {
    const snapshot = await memberSnapshot();
    const values = { [SNAPSHOT_KEY]: JSON.stringify(snapshot) };
    const other = createNativeStore({
      storage: memoryStorage(values),
      subjectId: "other-user",
    });
    expect(
      other.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(false);
    const signedOut = memoryStorage(values);
    const nobody = createNativeStore({ storage: signedOut, subjectId: null });
    expect(nobody.get().subject.principal).toBeNull();
    expect(signedOut.getItem(SNAPSHOT_KEY)).toBeNull();
  });

  it("clears persisted grants so the next launch is empty", async () => {
    const snapshot = await memberSnapshot();
    const storage = memoryStorage({
      [SNAPSHOT_KEY]: JSON.stringify(snapshot),
    });
    const store = createNativeStore({ storage, subjectId: "u1" });
    expect(
      store.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(true);
    store.get().clear();
    expect(storage.getItem(SNAPSHOT_KEY)).toBeNull();
    expect(
      store.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(false);
  });

  it("writes a fetched snapshot back to storage, never another user's", async () => {
    const snapshot = await memberSnapshot();
    const admin = await snapshotOf(adminUser);
    let next = snapshot;
    const storage = memoryStorage();
    const store = createNativeStore({
      storage,
      subjectId: "u1",
      snapshotUrl: "https://api.example.com/permdock/snapshot",
      fetch: async () =>
        new Response(JSON.stringify(next), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    await store.get().refresh();
    expect(storage.getItem(SNAPSHOT_KEY)).toBe(JSON.stringify(snapshot));
    next = admin;
    await store.get().refresh();
    expect(storage.getItem(SNAPSHOT_KEY)).toBe(JSON.stringify(snapshot));
  });
});

type AsyncStorage = PermDockStorage & {
  readonly writes: string[];
  readonly map: Map<string, string>;
};

/** An AsyncStorage-like store whose writes and removes reject. */
function asyncStorage(
  initial: Readonly<Record<string, string>> = {},
): AsyncStorage {
  const map = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    map,
    writes,
    getItem: async (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      writes.push(key);
      map.set(key, value);
      return Promise.reject(new Error("quota"));
    },
    removeItem: (key) => {
      writes.push(`-${key}`);
      map.delete(key);
      return Promise.reject(new Error("locked"));
    },
  };
}

/** A keychain-like store whose every call throws synchronously. */
function throwingStorage(): PermDockStorage {
  return {
    getItem: () => {
      throw new Error("keychain locked");
    },
    setItem: () => {
      throw new Error("value too large");
    },
    removeItem: () => {
      throw new Error("keychain locked");
    },
  };
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await Promise.resolve();
  }
}

describe("permdock/react-native storage", () => {
  it("accepts only a parseable snapshot for the expected subject", async () => {
    const snapshot = await memberSnapshot();
    const raw = JSON.stringify(snapshot);
    expect(acceptStored(null, "u1", false)).toBeUndefined();
    expect(acceptStored("", "u1", false)).toBeUndefined();
    expect(acceptStored("{not json", "u1", false)).toBeUndefined();
    expect(acceptStored('{"v":99}', "u1", false)).toBeUndefined();
    expect(acceptStored(raw, "someone-else", false)).toBeUndefined();
    expect(acceptStored(raw, null, false)).toBeUndefined();
    expect(acceptStored(raw, "u1", false)).toMatchObject({ kind: "snapshot" });
  });

  it("accepts only a signed copy when a verifier is configured", async () => {
    const raw = JSON.stringify(await memberSnapshot());
    expect(acceptStored(raw, "u1", true)).toBeUndefined();
    expect(acceptStored("a.b.c", "u1", true)).toEqual({
      kind: "signed",
      jws: "a.b.c",
    });
    expect(acceptStored("a.b.c", "u1", false)).toBeUndefined();
  });

  it("reads sync storage directly and defers async storage", async () => {
    const snapshot = await memberSnapshot();
    const values = {
      [SNAPSHOT_KEY]: JSON.stringify(snapshot),
      [TENANT_KEY]: "o1",
    };
    expect(
      readStoredSync(guardStorage(memoryStorage(values)), "u1", false),
    ).toMatchObject({ tenant: "o1" });
    expect(
      readStoredSync(
        guardStorage(memoryStorage({ [TENANT_KEY]: "o1" })),
        "u1",
        false,
      ),
    ).toEqual({ stored: undefined, tenant: undefined });
    expect(
      readStoredSync(guardStorage(asyncStorage(values)), "u1", false),
    ).toBeUndefined();
    const stored = await readStored(
      guardStorage(asyncStorage(values)),
      "u1",
      false,
    );
    expect(stored.tenant).toBe("o1");
    expect(stored.stored).toMatchObject({ kind: "snapshot" });
    expect(await readStored(guardStorage(asyncStorage()), "u1", false)).toEqual(
      { stored: undefined, tenant: undefined },
    );
  });

  it("reads a throwing or rejecting storage as empty", async () => {
    expect(
      readStoredSync(guardStorage(throwingStorage()), "u1", false),
    ).toEqual({ stored: undefined, tenant: undefined });
    const rejecting: PermDockStorage = {
      getItem: () => Promise.reject(new Error("io")),
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(await readStored(guardStorage(rejecting), "u1", false)).toEqual({
      stored: undefined,
      tenant: undefined,
    });
  });

  it("persists and clears through storage that rejects or throws without throwing", async () => {
    const raw = JSON.stringify(await memberSnapshot());
    const storage = asyncStorage();
    const guarded = guardStorage(storage);
    persistSnapshot(guarded, raw, undefined);
    persistSnapshot(guarded, raw, "o1");
    clearStorage(guarded);
    await settle();
    expect(storage.writes).toEqual([
      SNAPSHOT_KEY,
      SNAPSHOT_KEY,
      TENANT_KEY,
      `-${SNAPSHOT_KEY}`,
      `-${TENANT_KEY}`,
    ]);
    const throwing = guardStorage(throwingStorage());
    expect(() => {
      persistSnapshot(throwing, raw, "o1");
      clearStorage(throwing);
    }).not.toThrow();
    const sync = memoryStorage();
    persistSnapshot(guardStorage(sync), raw, "o1");
    expect(sync.getItem(TENANT_KEY)).toBe("o1");
  });
});

describe("permdock/react-native createNativeStore", () => {
  it("seeds from a snapshot string or object and persists it with the tenant", async () => {
    const snapshot = await memberSnapshot();
    const fromString = memoryStorage();
    const seeded = createNativeStore({
      storage: fromString,
      subjectId: "u1",
      snapshot: JSON.stringify(snapshot),
      tenant: "o1",
    });
    expect(
      seeded.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(true);
    expect(fromString.getItem(SNAPSHOT_KEY)).toBe(JSON.stringify(snapshot));
    expect(fromString.getItem(TENANT_KEY)).toBe("o1");
    const fromObject = memoryStorage();
    createNativeStore({ storage: fromObject, subjectId: "u1", snapshot });
    expect(fromObject.getItem(SNAPSHOT_KEY)).toBe(JSON.stringify(snapshot));
  });

  it("keeps a signed snapshot signed in storage and verifies it again on launch", async () => {
    const snapshot = await memberSnapshot();
    const storage = memoryStorage();
    const store = createNativeStore({
      storage,
      subjectId: "u1",
      snapshot: "a.b.c",
      verifier: signedVerifier(snapshot),
    });
    expect(store.get().status()).toBe("pending");
    await settle();
    expect(
      store.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(true);
    expect(storage.getItem(SNAPSHOT_KEY)).toBe("a.b.c");

    const relaunch = createNativeStore({
      storage,
      subjectId: "u1",
      verifier: signedVerifier(snapshot),
    });
    await settle();
    expect(
      relaunch.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(true);
  });

  it("refuses an unsigned persisted copy when a verifier is configured", async () => {
    const snapshot = await memberSnapshot();
    const store = createNativeStore({
      storage: memoryStorage({ [SNAPSHOT_KEY]: JSON.stringify(snapshot) }),
      subjectId: "u1",
      verifier: signedVerifier(snapshot),
    });
    await settle();
    expect(
      store.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(false);
  });

  it("is pending while async storage reads, then answers and restores the tenant", async () => {
    const snapshot = await memberSnapshot();
    const multi = { ...snapshot, tenants: ["o1", "o2"] };
    const storage = asyncStorage({
      [SNAPSHOT_KEY]: JSON.stringify(multi),
      [TENANT_KEY]: "o2",
    });
    const store = createNativeStore({ storage, subjectId: "u1" });
    expect(store.get().status()).toBe("pending");
    expect(
      store.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(false);
    await settle();
    expect(store.get().status()).toBe("ready");
    expect(
      store.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(true);
    expect(store.tenant()).toBe("o2");
  });

  it("reports a persisted snapshot stale until the refresh lands", async () => {
    const snapshot = await memberSnapshot();
    let release: (response: Response) => void = () => undefined;
    const store = createNativeStore({
      storage: memoryStorage({ [SNAPSHOT_KEY]: JSON.stringify(snapshot) }),
      subjectId: "u1",
      snapshotUrl: "/snap",
      fetch: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    expect(store.get().status()).toBe("stale");
    expect(
      store.permissionState(permissions.post.update, ownPost),
    ).toMatchObject({ allowed: true, status: "stale" });
    const refresh = store.get().refresh();
    release(new Response(JSON.stringify(snapshot)));
    await refresh;
    expect(store.get().status()).toBe("ready");
  });

  it("server-only after an empty async read; a cleared store ignores the read", async () => {
    const snapshot = await memberSnapshot();
    const storage = asyncStorage({ [SNAPSHOT_KEY]: JSON.stringify(snapshot) });
    const store = createNativeStore({ storage, subjectId: "u1" });
    store.get().clear();
    await settle();
    expect(
      store.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(false);
    const empty = createNativeStore({
      storage: asyncStorage(),
      subjectId: "u1",
    });
    await settle();
    expect(empty.get().subject.principal).toBeNull();
    expect(empty.get().status()).toBe("server-only");
  });

  it("does not crash on a storage that throws", async () => {
    const snapshot = await memberSnapshot();
    const store = createNativeStore({
      storage: throwingStorage(),
      subjectId: "u1",
      snapshot,
    });
    expect(
      store.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(true);
    expect(() => {
      store.get().clear();
    }).not.toThrow();
  });

  it("seeds a rebuilt store from the one it replaces, so guards never flip", async () => {
    const snapshot = await memberSnapshot();
    const storage = asyncStorage({ [SNAPSHOT_KEY]: JSON.stringify(snapshot) });
    const first = createNativeStore({ storage, subjectId: "u1" });
    await settle();
    const second = createNativeStore({
      storage,
      subjectId: "u1",
      previous: first,
    });
    expect(second.get().status()).not.toBe("pending");
    expect(
      second.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(true);
    const otherUser = createNativeStore({
      storage,
      subjectId: "u2",
      previous: second,
    });
    expect(
      otherUser.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(false);
  });

  it("applies only the latest of two overlapping local reads", async () => {
    const snapshot = await memberSnapshot();
    const admin = await snapshotOf(adminUser);
    const store = createNativeStore({
      storage: memoryStorage(),
      subjectId: "u1",
    });
    const releases: ((value: Snapshot) => void)[] = [];
    let notify: () => void = () => undefined;
    const stop = connectSource(store, {
      get: () =>
        new Promise<Snapshot>((resolve) => {
          releases.push(resolve);
        }),
      subscribe: (listener) => {
        notify = listener;
        return () => undefined;
      },
    });
    await settle();
    notify();
    await settle();
    releases[1]?.(snapshot);
    await settle();
    releases[0]?.(admin);
    await settle();
    expect(store.get().subject.principal?.id).toBe("u1");
    stop();
  });
});

function Probe(): string {
  const { allowed } = usePermission(permissions.post.update, ownPost);
  return allowed ? "allowed" : "denied";
}

describe("permdock/react-native connectSource", () => {
  it("re-renders nothing for a local read whose content did not change", async () => {
    const snapshot = await memberSnapshot();
    const store = createNativeStore({
      storage: memoryStorage(),
      subjectId: "u1",
      snapshot,
    });
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    let notify: () => void = () => undefined;
    let issuedAt = snapshot.issuedAt;
    const stop = connectSource(store, {
      get: () => {
        issuedAt += 1;
        return { ...snapshot, issuedAt };
      },
      subscribe: (listener) => {
        notify = listener;
        return () => undefined;
      },
    });
    await settle();
    notify();
    await settle();
    expect(notified).toBe(0);
    stop();
  });
});
