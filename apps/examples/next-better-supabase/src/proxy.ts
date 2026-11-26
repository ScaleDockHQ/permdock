import type { NextRequest } from "next/server";

import { NextResponse } from "next/server";
import { mayAccess } from "permdock";

import { env } from "./env.ts";
import { bsb } from "./lib/supabase/server.ts";
import { organizationId, orgHeader } from "./permdock/request.ts";
import { permissions, policy } from "./policy.ts";

function parts(pathname: string): readonly string[] {
  return pathname.split("/").filter((part) => part !== "");
}

/** The organization slug on an app or portal path, never on `/api`. */
function orgSlug(pathname: string): string | null {
  const path = parts(pathname);
  if (path.length < 2) {
    return null;
  }
  const second = path[1];
  if (second === "api" || second === "share") {
    return null;
  }
  if (second === "portal") {
    return path.length < 3 ? null : path[2];
  }
  return second;
}

function appQuotes(pathname: string): boolean {
  const path = parts(pathname);
  return path[1] !== "portal" && path[2] === "quotes";
}

function withOrg(
  request: NextRequest,
  slug: string | null,
): Response | undefined {
  if (slug === null) {
    return undefined;
  }
  const headers = new Headers(request.headers);
  headers.set(orgHeader, slug);
  return NextResponse.next({ request: { headers } });
}

async function hint(
  request: NextRequest,
  auth: { readonly kind: string; readonly claims?: unknown },
  slug: string | null,
  response: Response,
): Promise<Response> {
  if (
    env.without === "may-access" ||
    slug === null ||
    !appQuotes(request.nextUrl.pathname) ||
    auth.kind !== "user"
  ) {
    return response;
  }
  const tenant = await organizationId(slug);
  if (
    tenant === undefined ||
    mayAccess(policy, auth.claims, permissions.quotes.list, { tenant })
  ) {
    return response;
  }
  const url = request.nextUrl.clone();
  url.pathname = `/${parts(request.nextUrl.pathname)[0] ?? "en"}`;
  return NextResponse.redirect(url);
}

export async function proxy(request: NextRequest): Promise<Response> {
  if (env.without === "proxy") {
    return NextResponse.next();
  }
  const slug = orgSlug(request.nextUrl.pathname);
  const response = await bsb.proxy(request, {
    serverTiming: true,
    verifySession: "bootstrap",
    before: () => withOrg(request, slug),
    after: async (proxied, auth) => {
      const hinted = await hint(request, auth, slug, proxied);
      return hinted;
    },
  });
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
