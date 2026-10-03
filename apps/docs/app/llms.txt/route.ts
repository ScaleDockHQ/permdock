import { cacheLife } from 'next/cache';

import { markdownHeaders } from '@/lib/shared';
import { docsLlms } from '@/lib/source';

async function llmsIndex(): Promise<string> {
  'use cache';
  cacheLife('max');
  return docsLlms.index();
}

export async function GET(): Promise<Response> {
  return new Response(await llmsIndex(), { headers: markdownHeaders });
}
