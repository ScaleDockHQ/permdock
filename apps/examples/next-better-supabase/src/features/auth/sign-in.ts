import "server-only";
import { createAuthFlows } from "better-supabase/next/sign-in";

import { bsb } from "../../lib/supabase/server.ts";
import { demoPerson } from "./people.ts";

const auth = createAuthFlows(bsb);

/** Shared with `supabase/seed.sql`. A local demo password, not a secret. */
const DEMO_PASSWORD = "local-demo";

/**
 * Supabase Auth signs the session and runs `permdock.custom_access_token_hook`.
 * Returns the path to redirect to, or `null` when the id is not seeded.
 */
export async function signInAs(
  userId: string,
  next: string,
): Promise<string | null> {
  const person = demoPerson(userId);
  if (person === null) {
    return null;
  }
  const result = await auth.signInWithPassword({
    email: person.email,
    password: DEMO_PASSWORD,
    next,
  });
  if (!result.ok) {
    return null;
  }
  return result.data.redirectTo;
}
