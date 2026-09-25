import { revalidateTag } from 'next/cache';

import { resetStore } from '../../../../lib/store.ts';
import { orgs } from '../../../../nav.ts';

export function POST(): Response {
  if (process.env.NEXT_E2E !== '1') {
    return new Response(null, { status: 404 });
  }
  resetStore();
  for (const org of orgs) {
    revalidateTag(`org:${org.id}`, { expire: 0 });
  }
  revalidateTag('members', { expire: 0 });
  return Response.json({ ok: true });
}
