import { createPermDock } from "permdock/authzen";

import {
  subjectFromBearer,
  withoutPrefix,
} from "../../../../permdock/bearer.ts";
import { appPolicy } from "../../../../policy.ts";

const handle = createPermDock(appPolicy, {
  subject: async (request) => (await subjectFromBearer(request)).principal,
}).permdockHandler();

function shifted(request: Request): Request {
  return withoutPrefix(request, "/api/authzen");
}

export async function GET(request: Request): Promise<Response> {
  const response = await handle(shifted(request));
  return response;
}

export async function POST(request: Request): Promise<Response> {
  const response = await handle(shifted(request));
  return response;
}
