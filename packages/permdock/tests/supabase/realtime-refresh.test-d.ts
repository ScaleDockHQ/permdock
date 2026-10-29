import { createClient } from "@supabase/supabase-js";
import { describe, expectTypeOf, it } from "vitest";

import type { RefreshTrigger } from "../../src/client/refresh-on.ts";

import { supabaseRealtimeRefresh } from "../../src/supabase/client.ts";

describe(supabaseRealtimeRefresh, () => {
  it("takes a browser supabase-js client structurally", () => {
    const client = createClient("http://localhost:54321", "anon");
    expectTypeOf(
      supabaseRealtimeRefresh(client, { userId: "u1" }),
    ).toEqualTypeOf<RefreshTrigger>();
  });
});
