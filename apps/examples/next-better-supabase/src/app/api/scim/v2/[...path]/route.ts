import { memoryDirectoryStore, scimHandler, sha256Hex } from "permdock/scim";

import { organizationId, orgHeader } from "../../../../../permdock/request.ts";

const demoHash = sha256Hex("local-demo");

const handle = scimHandler({
  directory: memoryDirectoryStore(),
  tenant: async (request) => {
    const slug = request.headers.get(orgHeader);
    if (slug === null || slug === "") {
      return "";
    }
    return (await organizationId(slug)) ?? "";
  },
  token: { hash: "sha256", lookup: () => demoHash },
});

async function call(request: Request): Promise<Response> {
  const response = await handle(request);
  return response;
}

export async function GET(request: Request): Promise<Response> {
  const response = await call(request);
  return response;
}

export async function POST(request: Request): Promise<Response> {
  const response = await call(request);
  return response;
}

export async function PUT(request: Request): Promise<Response> {
  const response = await call(request);
  return response;
}

export async function PATCH(request: Request): Promise<Response> {
  const response = await call(request);
  return response;
}

export async function DELETE(request: Request): Promise<Response> {
  const response = await call(request);
  return response;
}
