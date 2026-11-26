import type { NextRequest } from "next/server";

import { NextResponse } from "next/server";

import { signInAs } from "../../../features/auth/sign-in.ts";

/**
 * The same Auth sign-in as the home page form, without a document navigation.
 * Instant specs and the measurement probes set the cookie here so the first
 * navigation of the measured page is the one under the lock.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const user = request.nextUrl.searchParams.get("user");
  const next = request.nextUrl.searchParams.get("next") ?? "/en";
  if (user === null || !next.startsWith("/")) {
    return new Response(null, { status: 400 });
  }
  const target = await signInAs(user, next);
  if (target === null) {
    return new Response(null, { status: 401 });
  }
  return new NextResponse(null, { status: 303, headers: { location: target } });
}
