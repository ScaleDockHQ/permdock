import { defineSupabase } from "better-supabase";
import { supabaseClaims } from "permdock/supabase";
import { z } from "zod";

import { schema } from "./generated.ts";

/** The app's own claim (`supabase.hook.claims`); `supabaseClaims()` covers PermDock's. */
const appClaims = z.object({
  datetime_preferences: z
    .object({
      timezone: z.string(),
      week_start: z.enum(["monday", "sunday"]),
      date_format: z.string(),
      time_format: z.enum(["12h", "24h"]),
    })
    .optional(),
});

export const betterSupabase = defineSupabase(schema).claims(
  supabaseClaims().extend(appClaims),
);

export const audience = "authenticated";
export const cookieName = "sb-example-auth-token";
