import type { Route } from "./+types/api.permdock";

import { permdockHandler } from "../permdock.server.ts";

const handler = permdockHandler();

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const response = await handler.GET(request);
  return response;
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  const response = await handler.POST(request);
  return response;
}
