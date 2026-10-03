import { searchServer } from '@/lib/search';
import { publicCacheControl } from '@/lib/shared';

export async function GET(request: Request): Promise<Response> {
  const response = await searchServer.GET(request);
  response.headers.set('Cache-Control', publicCacheControl);
  return response;
}
