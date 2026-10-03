import type { McpAuthInfo } from "permdock/mcp";

import { McpServer } from "@modelcontextprotocol/server";
import { createPermDock, subjectFromMcp } from "permdock/mcp";
import { saasPolicy } from "permdock/testing/saas";
import { saasPermissions as p } from "permdock/testing/saas/permissions";
import { z } from "zod";

import {
  findOrg,
  findProject,
  membershipsOf,
  projectsOf,
  removeProject,
} from "@permdock/e2e-saas-kit";

import { RESOURCE } from "./config.ts";

function tenantOf(authInfo: McpAuthInfo): string | undefined {
  const tenant = authInfo.extra?.["tenant"];
  return typeof tenant === "string" && tenant !== "" ? tenant : undefined;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

/**
 * Identity, client and scopes come from the verified token; memberships and
 * the plan are read from the store on every call, so a demotion applies to
 * the next tool call without a new token.
 */
const { protectServer } = createPermDock(saasPolicy, {
  subject: (authInfo) => {
    const subject = subjectFromMcp(authInfo);
    if (subject.principal === null) {
      return subject;
    }
    const org = findOrg(tenantOf(authInfo) ?? "");
    return {
      ...subject,
      principal: {
        ...subject.principal,
        memberships: membershipsOf(subject.principal.id),
        plans: org === undefined ? [] : [org.plan],
      },
    };
  },
  tenant: tenantOf,
  requireAuthInfo: true,
  resource: RESOURCE,
  customRoles: {
    rolesFor: (tenant) => [...(findOrg(tenant)?.customRoles ?? [])],
  },
});

export function createMcpServer(): McpServer {
  const mcp = new McpServer(
    { name: "saas-projects", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  const server = protectServer(mcp);
  const byId = z.object({ id: z.string() });
  server.registerTool(
    "list_projects",
    { permission: p.project.list, description: "List the org’s projects" },
    (ctx) =>
      text(
        projectsOf(tenantOf(ctx.http?.authInfo ?? {}) ?? "").map(
          (row) => row.id,
        ),
      ),
  );
  server.registerTool(
    "delete_project",
    {
      permission: p.project.delete,
      description: "Delete a project",
      inputSchema: byId,
      data: ({ id }) => findProject(id) ?? null,
    },
    ({ id }) => {
      removeProject(id);
      return text({ deleted: id });
    },
  );
  server.registerTool(
    "read_analytics",
    { permission: p.analytics.read, description: "Read org analytics (Pro)" },
    () => text({ visits: 42 }),
  );
  return mcp;
}
