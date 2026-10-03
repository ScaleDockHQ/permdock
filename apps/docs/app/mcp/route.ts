import { createDocsMcpHandler, withCors } from '@/lib/docs-mcp';
import { searchServer } from '@/lib/search';
import { docsLlms, source } from '@/lib/source';

const handler = createDocsMcpHandler({
  source,
  search: searchServer,
  llms: docsLlms,
});

export function OPTIONS(): Response {
  return withCors(new Response(null, { status: 204 }));
}

async function serve(request: Request): Promise<Response> {
  return withCors(await handler.fetch(request));
}

export { serve as DELETE, serve as GET, serve as POST };
