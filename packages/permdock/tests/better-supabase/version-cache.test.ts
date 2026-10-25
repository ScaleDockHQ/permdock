import { defineSchema, defineSupabase } from "better-supabase";
import * as server from "better-supabase/server";
import { createTestSigner } from "better-supabase/testing";
import { describe, expect, it } from "vitest";

import { memoryVersionCache } from "../../src/index.ts";

const USER = "22222222-2222-4222-8222-222222222222";
const PROJECT_URL = "https://abcdefghijklmnopqrst.supabase.co";

type Subscribe = (options: {
  readonly client: unknown;
  readonly topic: string;
  readonly event: string;
  readonly userIdKey: string;
  readonly versions: { evict: (userId: string) => void };
}) => { readonly ready: Promise<unknown>; close: () => Promise<void> };

function isSubscribe(value: unknown): value is Subscribe {
  return typeof value === "function";
}

function isForget(value: unknown): value is (userId: string) => Promise<void> {
  return typeof value === "function";
}

/**
 * better-supabase 0.15 and later: `subscribeAuthzVersions` and
 * `ServerOptions.versions`.
 */
const subscribe: unknown = Reflect.get(server, "subscribeAuthzVersions");
const shared = isSubscribe(subscribe);

/** A cache holding USER's version 3, read once. */
async function warmCache() {
  const cache = memoryVersionCache({ maxStaleMs: 30_000 });
  await cache.current({ id: USER }, () => 3, { live: false });
  return cache;
}

/** A Realtime client whose one channel delivers `send`'s payloads. */
function fakeRealtime() {
  const handlers: ((message: { payload?: unknown }) => void)[] = [];
  const client = {
    channel() {
      const channel = {
        on(
          _type: string,
          _filter: unknown,
          callback: (message: { payload?: unknown }) => void,
        ) {
          handlers.push(callback);
          return channel;
        },
        subscribe(callback?: (status: string) => void) {
          queueMicrotask(() => callback?.("SUBSCRIBED"));
          return channel;
        },
        unsubscribe: async () => "ok",
      };
      return channel;
    },
  };
  const send = (payload: unknown): void => {
    for (const handler of handlers) handler({ payload });
  };
  return { client, send };
}

describe("one memoryVersionCache shared with better-supabase", () => {
  it.runIf(shared)("is evicted by createServer's forgetSession", async () => {
    const cache = await warmCache();
    const signer = await createTestSigner();
    // Not a literal, so 0.13's ServerOptions, which has no versions, still type-checks.
    const options = {
      env: {
        url: PROJECT_URL,
        publishableKey: "sb_publishable_test",
        jwksUrl: new URL(`${PROJECT_URL}/auth/v1/.well-known/jwks.json`),
      },
      auth: { jwks: signer.jwks },
      versions: cache,
    };
    const bsb = server.createServer(
      defineSupabase(
        defineSchema({
          version: 1,
          casing: "snake",
          tables: {},
          enums: {},
          functions: {},
        }),
      ),
      options,
    );
    const forget: unknown = Reflect.get(bsb, "forgetSession");
    expect(isForget(forget)).toBe(true);
    if (!isForget(forget)) return;
    expect(cache.stats().size).toBe(1);
    await forget.call(bsb, USER);
    expect(cache.stats()).toMatchObject({ size: 0, evictions: 1 });
  });

  it.runIf(shared)(
    "is evicted by subscribeAuthzVersions on a Realtime message",
    async () => {
      if (!isSubscribe(subscribe)) return;
      const cache = await warmCache();
      const realtime = fakeRealtime();
      const subscription = subscribe({
        client: realtime.client,
        topic: "authz-versions",
        event: "changed",
        userIdKey: "user_id",
        versions: cache,
      });
      await subscription.ready;
      realtime.send({ user_id: USER });
      expect(cache.stats()).toMatchObject({ size: 0, evictions: 1 });
      await subscription.close();
    },
  );
});
