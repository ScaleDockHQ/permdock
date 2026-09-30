import type { NextRequest } from 'next/server';

import { NextResponse } from 'next/server';
import { mayAccess } from 'permdock';

import { SESSION_COOKIE, verifySession } from './lib/token.ts';
import { navItemFor } from './nav.ts';
import { policy, subjectOf } from './policy.ts';

/**
 * Optimistic routing: redirect only when the verified claims provably lack
 * the page's permission. Pages and Server Actions still enforce.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (
    process.env['NEXT_E2E'] === '1' &&
    request.headers.get('x-e2e-skip-proxy') === '1'
  ) {
    return NextResponse.next();
  }
  const [org, section] = request.nextUrl.pathname.split('/').filter(Boolean);
  if (org === undefined) {
    return NextResponse.next();
  }
  const claims = await verifySession(
    request.cookies.get(SESSION_COOKIE)?.value,
  );
  if (claims === null) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  const item = section === undefined ? undefined : navItemFor(section);
  if (
    item !== undefined &&
    !mayAccess(policy, subjectOf(claims), item.permission, { tenant: org })
  ) {
    const target = new URL(`/${org}`, request.url);
    target.searchParams.set('denied', item.id);
    return NextResponse.redirect(target);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next|api|login|favicon.ico).+)'],
};
