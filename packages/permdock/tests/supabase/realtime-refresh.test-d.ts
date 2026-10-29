import { createClient } from "@supabase/supabase-js";
import { describe, expectTypeOf, it } from "vitest";

import type { RefreshTrigger } from "../../src/client/refresh-on.ts";
import type { SubscribeForeground } from "../../src/react-native/types.ts";

import { supabaseRealtimeRefresh } from "../../src/supabase/client.ts";

describe(supabaseRealtimeRefresh, () => {
  it("takes a browser supabase-js client structurally", () => {
    const client = createClient("http://localhost:54321", "anon");
    expectTypeOf(
      supabaseRealtimeRefresh(client, { userId: "u1" }),
    ).toEqualTypeOf<RefreshTrigger>();
  });

  it("takes the app's own channel and a subscribeForeground function", () => {
    const client = createClient("http://localhost:54321", "anon");
    const channel = client.channel("authz:u1", { config: { private: true } });
    const foreground: SubscribeForeground = () => () => undefined;
    expectTypeOf(
      supabaseRealtimeRefresh(client, { userId: "u1", channel, foreground }),
    ).toEqualTypeOf<RefreshTrigger>();
  });
});
