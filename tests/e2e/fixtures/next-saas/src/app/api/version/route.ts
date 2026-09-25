import type { NextRequest } from 'next/server';

import { getClaims } from '../../../lib/session.ts';
import { changedAt } from '../../../lib/store.ts';

/** The refresh signal: when the org's plan or the caller's roles last changed. */
export async function GET(request: NextRequest): Promise<Response> {
  const org = request.nextUrl.searchParams.get('org') ?? '';
  const claims = await getClaims();
  const keys = [
    `org:${org}`,
    ...(claims === null ? [] : [`user:${claims.sub}`]),
  ];
  return Response.json(
    { changedAt: changedAt(keys) },
    { headers: { 'cache-control': 'no-store' } },
  );
}
