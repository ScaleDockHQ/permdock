import type { AuthzVersionClient } from "better-supabase/server";

import { defineSchema, defineSupabase } from "better-supabase";
import {
  AUTHZ_EVENT,
  AUTHZ_TOPIC,
  createServer,
  subscribeAuthzVersions,
} from "better-supabase/server";
import { createTestSigner } from "better-supabase/testing";
import { describe, expect, it } from "vitest";

import { BETTER_SUPABASE_AUTHZ_TOPIC } from "../../src/cli/project/better-supabase.ts";
import { memoryVersionCache } from "../../src/index.ts";
import { AUTHZ_EVENT as PERMDOCK_AUTHZ_EVENT } from "../../src/supabase/index.ts";

const USER = "22222222-2222-4222-8222-222222222222";
const PROJECT_URL = "https://abcdefghijklmnopqrst.supabase.co";

/** A cache holding USER's version 3, read once. */
async function warmCache() {
  const cache = memoryVersionCache({ maxStaleMs: 30_000 });
  await cache.current({ id: USER }, () => 3, { live: false });
  return cache;
}

/** A Realtime client whose one channel delivers `send`'s payloads. */
function fakeRealtime() {
  const handlers: ((message: { payload?: unknown }) => void)[] = [];
  const topics: string[] = [];
  const client: AuthzVersionClient = {
    channel(topic: string) {
      topics.push(topic);
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
  return { client, send, topics };
}

describe("one memoryVersionCache shared with better-supabase", () => {
  it("is evicted by createServer's evictSession", async () => {
    const cache = await warmCache();
    const signer = await createTestSigner();
    const bsb = createServer(
      defineSupabase(
        defineSchema({
          version: 1,
          casing: "snake",
          tables: {},
          enums: {},
          functions: {},
        }),
      ),
      {
        env: {
          url: PROJECT_URL,
          publishableKey: "sb_publishable_test",
          jwksUrl: new URL(`${PROJECT_URL}/auth/v1/.well-known/jwks.json`),
        },
        auth: { jwks: signer.jwks },
        versions: cache,
      },
    );
    expect(cache.stats().size).toBe(1);
    await bsb.evictSession(USER);
    expect(cache.stats()).toMatchObject({ size: 0, evictions: 1 });
  });

  it("names better-supabase's server topic and event", () => {
    expect(BETTER_SUPABASE_AUTHZ_TOPIC).toBe(AUTHZ_TOPIC);
    expect(PERMDOCK_AUTHZ_EVENT).toBe(AUTHZ_EVENT);
  });

  it("is evicted by subscribeAuthzVersions on the topic the generated trigger sends on", async () => {
    const cache = await warmCache();
    const realtime = fakeRealtime();
    const subscription = subscribeAuthzVersions({
      client: realtime.client,
      versions: cache,
    });
    await subscription.ready;
    expect(realtime.topics).toStrictEqual([BETTER_SUPABASE_AUTHZ_TOPIC]);
    realtime.send({ user_id: USER, version: 2 });
    expect(cache.stats()).toMatchObject({ size: 0, evictions: 1 });
    await subscription.close();
  });
});
