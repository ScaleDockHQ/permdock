import { llms } from 'fumadocs-core/source';

import { source } from '@/lib/source';

export async function GET() {
  return new Response(await llms(source).index());
}
