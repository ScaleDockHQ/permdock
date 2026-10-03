import { saasPermissions as p } from "permdock/testing/saas/permissions";

import { findProject, removeProject } from "@permdock/e2e-saas-kit";

import { kernel } from "../../../../lib/server";

function projectId(request: Request): string {
  return decodeURIComponent(
    new URL(request.url).pathname.split("/").at(-2) ?? "",
  );
}

const guard = kernel.protect(p.project.delete, (request) =>
  findProject(projectId(request)),
);

/** A fresh server-side check through `permdock/server`; the UI never decides. */
export async function POST(request: Request): Promise<Response> {
  const result = await guard(request);
  if (!result.ok) {
    return result.response;
  }
  removeProject(result.data.id);
  return Response.json({ ok: true });
}
