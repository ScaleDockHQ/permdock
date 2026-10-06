import { createClient } from "@supabase/supabase-js";

import type { SupabaseRpcClient } from "../../src/supabase/index.ts";

import {
  postgrestSources,
  supabaseApprovalStore,
} from "../../src/supabase/index.ts";

type Database = {
  public: {
    Tables: Record<never, never>;
    Views: Record<never, never>;
    Functions: {
      permdock_subject_for: { Args: { p_user: string }; Returns: unknown };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
  permdock: {
    Tables: Record<never, never>;
    Views: Record<never, never>;
    Functions: {
      subject_for: { Args: { p_user: string }; Returns: unknown };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};

const typed = createClient<Database>("https://example.supabase.co", "key");
postgrestSources(typed, { schema: "public", fn: "permdock_subject_for" });
supabaseApprovalStore(typed);

const untyped = createClient("https://example.supabase.co", "key");
postgrestSources(untyped);
supabaseApprovalStore(untyped);

const fake: SupabaseRpcClient = {
  schema: (name) => ({
    rpc: async (fn, args) => ({ data: [name, fn, args], error: null }),
  }),
};
postgrestSources(fake);
supabaseApprovalStore(fake);

// @ts-expect-error a client without rpc is not a client
postgrestSources({ schema: () => ({}) });
