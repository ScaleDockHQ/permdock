import { revalidateTag } from 'next/cache';

import { setPlan } from '../../../../lib/store.ts';

/**
 * A simulated billing webhook. Route Handlers cannot call `updateTag`, so
 * the shared org entry is expired with `revalidateTag(tag, { expire: 0 })`.
 */
export async function POST(request: Request): Promise<Response> {
  if (process.env.NEXT_E2E !== '1') {
    return new Response(null, { status: 404 });
  }
  const body = (await request.json()) as {
    readonly org?: unknown;
    readonly plan?: unknown;
  };
  if (
    typeof body.org !== 'string' ||
    (body.plan !== 'free' && body.plan !== 'pro')
  ) {
    return Response.json({ ok: false }, { status: 400 });
  }
  if (!setPlan(body.org, body.plan)) {
    return Response.json({ ok: false }, { status: 404 });
  }
  revalidateTag(`org:${body.org}`, { expire: 0 });
  return Response.json({ ok: true });
}
