import { revalidateTag } from 'next/cache';
import { cookies } from 'next/headers';
import { snapshotTag } from 'permdock/next';

import { getClaims } from '../../../lib/session.ts';
import { SESSION_COOKIE } from '../../../lib/token.ts';

/**
 * Sign-out is a document navigation, not a Server Action: Next keeps visited
 * routes as hidden trees in the page, so a client-side redirect would leave
 * the previous user's shell in the DOM for the next one.
 */
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get('origin');
  if (origin !== null && new URL(origin).host !== request.headers.get('host')) {
    return new Response(null, { status: 403 });
  }
  const claims = await getClaims();
  (await cookies()).delete(SESSION_COOKIE);
  if (claims !== null) {
    revalidateTag(snapshotTag(claims.sub), { expire: 0 });
  }
  return new Response(null, {
    status: 303,
    headers: { location: '/login' },
  });
}
