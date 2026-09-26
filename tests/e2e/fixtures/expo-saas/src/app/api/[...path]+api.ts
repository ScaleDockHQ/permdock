import { handleSaasRoute } from '@permdock/e2e-saas-kit';

async function route(request: Request): Promise<Response> {
  return (
    (await handleSaasRoute(request)) ?? new Response(null, { status: 404 })
  );
}

export { route as GET, route as POST };
