import { describe, expect, it } from "vitest";

import type { CacheEntry } from "../../src/client/batch.ts";
import type { Permission } from "../../src/core/permission-types.ts";

import {
  MAX_ANSWERS,
  MAX_BATCH_BYTES,
  MAX_BATCH_ITEMS,
  createBatch,
} from "../../src/client/batch.ts";
import { emptySnapshot } from "../../src/core/from-snapshot.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { permissions, policy } from "../fixtures/saas.ts";

const read: Permission = permissions.project.read;

function harness() {
  const posts: { evaluations: readonly unknown[] }[] = [];
  const answers = new Map<string, CacheEntry>();
  const batch = createBatch({
    endpoint: "/evaluations",
    request: (_url, body) => {
      // SAFETY: the batch posts `{ evaluations }` only.
      const sent = body as { evaluations: readonly unknown[] };
      posts.push(sent);
      return Promise.resolve(
        Response.json({ evaluations: sent.evaluations.map(() => ({})) }),
      );
    },
    answers,
    onServerOnly: undefined,
    generation: () => 0,
    snapshot: () => emptySnapshot(),
    instance: () => getPermDockSync(policy, { id: "u1", memberships: [] }),
    emit: () => undefined,
    emitSoon: () => undefined,
  });
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 20; turn += 1) {
      await Promise.resolve();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  };
  return { posts, answers, batch, settle };
}

describe("client batch limits", () => {
  it("posts at most MAX_BATCH_ITEMS evaluations per request", async () => {
    const { posts, batch, settle } = harness();
    const total = MAX_BATCH_ITEMS * 2 + 5;
    for (let index = 0; index < total; index += 1) {
      batch.enqueue(`k${String(index)}`, read, { id: `r${String(index)}` });
    }
    await settle();
    expect(posts.map((post) => post.evaluations.length)).toStrictEqual([
      MAX_BATCH_ITEMS,
      MAX_BATCH_ITEMS,
      5,
    ]);
  });

  it("keeps each request under MAX_BATCH_BYTES", async () => {
    const { posts, batch, settle } = harness();
    const blob = "x".repeat(MAX_BATCH_BYTES / 4);
    for (let index = 0; index < 10; index += 1) {
      batch.enqueue(`k${String(index)}`, read, {
        id: `r${String(index)}`,
        blob,
      });
    }
    await settle();
    expect(posts.length).toBeGreaterThan(1);
    for (const post of posts) {
      expect(JSON.stringify(post).length).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }
    expect(posts.flatMap((post) => post.evaluations)).toHaveLength(10);
  });

  it("drops the oldest answered entries past MAX_ANSWERS and keeps pending ones", async () => {
    const { answers, batch, settle } = harness();
    for (let index = 0; index < MAX_ANSWERS + 50; index += 1) {
      batch.enqueue(`k${String(index)}`, read, { id: `r${String(index)}` });
      if (index % 200 === 0) {
        await settle();
      }
    }
    await settle();
    expect(answers.size).toBeLessThanOrEqual(MAX_ANSWERS);
    expect(answers.has(`k${String(MAX_ANSWERS + 49)}`)).toBe(true);
    expect(answers.has("k0")).toBe(false);
  });
});
