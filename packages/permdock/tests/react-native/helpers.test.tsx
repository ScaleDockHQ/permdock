import type { ReactElement } from "react";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Permission } from "../../src/core/permissions.ts";
import type { PermDockStorage } from "../../src/react-native/types.ts";

import { localSnapshotManifest } from "../../src/core/local-manifest.ts";
import { parseLocalSnapshotManifest } from "../../src/core/parse-local-manifest.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import {
  usePermissionGuard,
  useSnapshotReady,
} from "../../src/react-native/guards.ts";
import { PermDockProvider } from "../../src/react-native/provider.tsx";
import {
  mmkvStorage,
  secureStoreStorage,
  type SecureStoreModule,
} from "../../src/react-native/storage-adapters.ts";
import { memoryStorage, SNAPSHOT_KEY } from "../../src/react-native/storage.ts";
import {
  appStateForeground,
  netInfoOnline,
} from "../../src/react-native/subscriptions.ts";
import {
  memberUser,
  ownPost,
  otherPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

function fakeSecureStore(): SecureStoreModule & {
  readonly items: Map<string, string>;
  failAfter: number | undefined;
} {
  const items = new Map<string, string>();
  const store: SecureStoreModule & {
    readonly items: Map<string, string>;
    failAfter: number | undefined;
  } = {
    items,
    failAfter: undefined,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (store.failAfter !== undefined) {
        if (store.failAfter === 0) {
          throw new Error("keychain full");
        }
        store.failAfter -= 1;
      }
      if (new TextEncoder().encode(value).length > 2048) {
        throw new Error("value over 2048 bytes");
      }
      items.set(key, value);
    },
    deleteItemAsync: async (key: string) => {
      items.delete(key);
    },
  };
  return store;
}

describe("secureStoreStorage", () => {
  it("round-trips a value larger than one SecureStore item", async () => {
    const fake = fakeSecureStore();
    const storage = secureStoreStorage(fake);
    const value = `${"a".repeat(3000)}é€😀${"b".repeat(2500)}`;
    await storage.setItem(SNAPSHOT_KEY, value);
    expect(storage.getItem(SNAPSHOT_KEY)).toBe(value);
    expect(fake.items.size).toBe(4);
  });

  it("removes the chunks a shorter value no longer needs", async () => {
    const fake = fakeSecureStore();
    const storage = secureStoreStorage(fake);
    await storage.setItem("k", "x".repeat(5000));
    await storage.setItem("k", "short");
    expect(storage.getItem("k")).toBe("short");
    expect([...fake.items.keys()].toSorted()).toEqual(["k", "k.0"]);
    await storage.removeItem("k");
    expect(fake.items.size).toBe(0);
  });

  it("reads an interrupted write as absent", async () => {
    const fake = fakeSecureStore();
    const storage = secureStoreStorage(fake);
    await storage.setItem("k", "old");
    fake.failAfter = 1;
    await expect(storage.setItem("k", "x".repeat(5000))).rejects.toThrow(
      "keychain full",
    );
    expect(storage.getItem("k")).toBeNull();
  });

  it("reads a value it did not write as absent", () => {
    const fake = fakeSecureStore();
    fake.items.set("k", '{"v":1}');
    expect(secureStoreStorage(fake).getItem("k")).toBeNull();
  });
});

describe("mmkvStorage", () => {
  it("works with the v4 remove and the v3 delete", () => {
    for (const method of ["remove", "delete"] as const) {
      const items = new Map<string, string>();
      const instance = {
        getString: (key: string) => items.get(key),
        set: (key: string, value: string) => {
          items.set(key, value);
        },
        [method]: (key: string) => items.delete(key),
      };
      // SAFETY: instance has exactly one of the two removal methods.
      const storage = mmkvStorage(
        instance as Parameters<typeof mmkvStorage>[0],
      );
      expect(storage.getItem("k")).toBeNull();
      storage.setItem("k", "v");
      expect(storage.getItem("k")).toBe("v");
      storage.removeItem("k");
      expect(items.size).toBe(0);
    }
  });
});

describe("appStateForeground and netInfoOnline", () => {
  it("maps active and background, and ignores inactive", () => {
    let emit: (state: string) => void = () => undefined;
    let removed = false;
    const subscribe = appStateForeground({
      addEventListener: (_type, listener) => {
        emit = listener;
        return {
          remove: () => {
            removed = true;
          },
        };
      },
    });
    const seen: (boolean | undefined)[] = [];
    const off = subscribe((active) => {
      seen.push(active);
    });
    emit("inactive");
    emit("background");
    emit("active");
    off();
    expect(seen).toEqual([false, true]);
    expect(removed).toBe(true);
  });

  it("treats an unknown connection as online", () => {
    let emit: Parameters<
      Parameters<typeof netInfoOnline>[0]["addEventListener"]
    >[0] = () => undefined;
    const subscribe = netInfoOnline({
      addEventListener: (listener) => {
        emit = listener;
        return () => undefined;
      },
    });
    const seen: boolean[] = [];
    subscribe((online) => {
      seen.push(online);
    });
    emit({ isConnected: true, isInternetReachable: null });
    emit({ isConnected: null });
    emit({ isConnected: true, isInternetReachable: false });
    emit({ isConnected: false });
    expect(seen).toEqual([true, true, false, false]);
  });
});

describe("parseLocalSnapshotManifest", () => {
  it("accepts what localSnapshotManifest writes, after a JSON round trip", () => {
    const json: unknown = JSON.parse(
      JSON.stringify(localSnapshotManifest(policy)),
    );
    expect(parseLocalSnapshotManifest(json)).toBe(true);
  });

  it("rejects another version, a wrong shape and prototype keys", () => {
    const good: Record<string, unknown> = JSON.parse(
      JSON.stringify(localSnapshotManifest(policy)),
    );
    expect(parseLocalSnapshotManifest({ ...good, v: 2 })).toBe(false);
    expect(parseLocalSnapshotManifest({ ...good, roles: [1] })).toBe(false);
    expect(parseLocalSnapshotManifest({ ...good, grants: [{}] })).toBe(false);
    expect(parseLocalSnapshotManifest({ ...good, custom: [] })).toBe(false);
    expect(
      parseLocalSnapshotManifest(
        JSON.parse(
          JSON.stringify(good).replace('"roles"', '"__proto__":{},"roles"'),
        ),
      ),
    ).toBe(false);
    expect(parseLocalSnapshotManifest(null)).toBe(false);
  });
});

function Guard(props: {
  readonly permission: Permission | readonly Permission[];
  readonly data?: unknown;
}): ReactElement {
  const ready = useSnapshotReady();
  const allowed = usePermissionGuard(props.permission, props.data);
  return <>{`${String(ready)}:${String(allowed)}`}</>;
}

function render(storage: PermDockStorage, guard: ReactElement): string {
  return renderToStaticMarkup(
    <PermDockProvider storage={storage} subjectId={memberUser.id}>
      {guard}
    </PermDockProvider>,
  );
}

describe("useSnapshotReady and usePermissionGuard", () => {
  it("allow only when every permission is allowed for the row", async () => {
    // SAFETY: memberUser is a quick-start user fixture; only the policy generic is erased.
    const server = await createPermDock(policy as never, memberUser);
    const storage = memoryStorage({
      [SNAPSHOT_KEY]: JSON.stringify(server.snapshot()),
    });
    const { post } = permissions;
    expect(render(storage, <Guard permission={post.read} />)).toBe("true:true");
    expect(
      render(
        storage,
        <Guard permission={[post.read, post.update]} data={ownPost} />,
      ),
    ).toBe("true:true");
    expect(
      render(
        storage,
        <Guard permission={[post.read, post.update]} data={otherPost} />,
      ),
    ).toBe("true:false");
    expect(render(storage, <Guard permission={[]} />)).toBe("true:false");
  });

  it("stay false while async storage is read", async () => {
    const storage = {
      getItem: () =>
        new Promise<string | null>(() => {
          // never settles
        }),
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(render(storage, <Guard permission={permissions.post.read} />)).toBe(
      "false:false",
    );
  });
});
