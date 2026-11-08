import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import type { Snapshot } from "../../src/core/snapshot-types.ts";

import { emptySnapshot } from "../../src/core/from-snapshot.ts";
import { createSnapshotRegistry } from "../../src/next/snapshot-memo.ts";

const snapshot: Snapshot = emptySnapshot();

describe(createSnapshotRegistry, () => {
  it("answers one promise for equal inputs and another for different ones", () => {
    const registry = createSnapshotRegistry(false, () => {});
    const object = { name: "post" };
    const build = vi.fn<() => Promise<Snapshot>>(() =>
      Promise.resolve(snapshot),
    );
    const first = registry.memo({ include: [object] }, build);
    expect(registry.memo({ include: [object] }, build)).toBe(first);
    expect(registry.memo({ include: [{ name: "post" }] }, build)).not.toBe(
      first,
    );
    expect(
      registry.memo({ include: [object], tenant: "acme" }, build),
    ).not.toBe(first);
    const keyed = registry.memo({ include: [{ key: "post.read" }] }, build);
    expect(registry.memo({ include: [{ key: "post.read" }] }, build)).toBe(
      keyed,
    );
    expect(build).toHaveBeenCalledTimes(4);
  });

  it("reports an equal snapshot from a second promise, once per repeat", async () => {
    const onDuplicate = vi.fn<(bytes: number) => void>();
    const registry = createSnapshotRegistry(true, onDuplicate);
    const first = Promise.resolve(snapshot);
    registry.watch(first);
    registry.watch(first);
    registry.watch(Promise.resolve(snapshot));
    registry.watch(Promise.reject(new Error("refused")));
    await sleep(5);
    expect(onDuplicate).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(snapshot).length,
    );
  });

  it("watches nothing outside development", async () => {
    const onDuplicate = vi.fn<(bytes: number) => void>();
    const registry = createSnapshotRegistry(false, onDuplicate);
    registry.watch(Promise.resolve(snapshot));
    registry.watch(Promise.resolve(snapshot));
    await sleep(5);
    expect(onDuplicate).not.toHaveBeenCalled();
  });
});
