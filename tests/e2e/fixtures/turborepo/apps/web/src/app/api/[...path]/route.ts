import { handleSaasRoute } from '@permdock/e2e-saas-kit';

async function handle(request: Request): Promise<Response> {
  return (
    (await handleSaasRoute(request)) ?? new Response(null, { status: 404 })
  );
}

export const GET = handle;
export const POST = handle;
