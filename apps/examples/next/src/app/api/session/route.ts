import { revalidateTag } from "next/cache";
import { cookies } from "next/headers";
import { snapshotTag } from "permdock/next";

import {
  SESSION_COOKIE,
  sessionUserId,
  sessionValue,
} from "../../../lib/session.ts";
import { people } from "../../../lib/store.ts";

/**
 * Sign-in and sign-out are document navigations: the App Router keeps visited
 * routes as hidden trees, so a client-side switch could leave the previous
 * user's gated shell in the page.
 */
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin !== null && new URL(origin).host !== request.headers.get("host")) {
    return new Response(null, { status: 403 });
  }
  const jar = await cookies();
  const previous = await sessionUserId();
  if (previous !== null) {
    revalidateTag(snapshotTag(previous), { expire: 0 });
  }
  const user = (await request.formData()).get("user");
  const person = people.find((item) => item.id === user) ?? null;
  if (person === null) {
    jar.delete(SESSION_COOKIE);
    return new Response(null, { status: 303, headers: { location: "/" } });
  }
  jar.set(SESSION_COOKIE, sessionValue(person.id), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  revalidateTag(snapshotTag(person.id), { expire: 0 });
  const home = person.id === "carol" ? "/portal/acme" : "/acme";
  return new Response(null, { status: 303, headers: { location: home } });
}
