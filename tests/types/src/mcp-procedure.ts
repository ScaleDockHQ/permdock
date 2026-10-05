import type { Permission } from "permdock";
import type { McpProcedureEnforcement, ProcedureMcpServer } from "permdock/mcp";

import { McpServer } from "@modelcontextprotocol/server";
import { createPermDock } from "permdock/mcp";
import { permissionOf } from "permdock/orpc";

import { jobPolicy, jobs } from "./levels.js";

const enforcement: McpProcedureEnforcement = {
  enforce: "procedure",
  permissionFor: (name) => (name === "read_job" ? jobs.job.read : undefined),
};

const server: ProcedureMcpServer = createPermDock(jobPolicy, {
  subject: () => ({ id: "u1" }),
}).protectServer(
  new McpServer({ name: "jobs", version: "1.0.0" }),
  enforcement,
);

server.registerTool("read_job", {}, () => ({ content: [] }));

server.registerTool(
  "read_job_2",
  // @ts-expect-error a procedure tool takes no loader; its procedure loads the row
  { data: () => null },
  () => ({ content: [] }),
);

export const found: Permission | undefined = permissionOf({});
