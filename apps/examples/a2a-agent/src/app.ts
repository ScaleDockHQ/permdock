import { Hono } from "hono";
import { createPermDock } from "permdock/a2a";

import { ownPost, permissions } from "./permissions.ts";
import { adminUser, memberUser, policy } from "./policy.ts";

const { agentCard, extendedAgentCard, protectSkill } = createPermDock(policy, {
  subject: (auth) => (auth.clientId === "admin" ? adminUser : memberUser),
  card: {
    name: "Posts agent",
    url: "https://agent.example.com/a2a",
    version: "1.0.0",
  },
  securitySchemes: {
    oauth: {
      type: "oauth2",
      oauth2MetadataUrl:
        "https://auth.example.com/.well-known/oauth-authorization-server",
    },
  },
  skills: {
    summarise: {
      permission: permissions.post.read,
      description: "Summarise a post",
      data: async () => {
        const row = await Promise.resolve(ownPost);
        return row;
      },
    },
    publish: {
      permission: permissions.post.publish,
      data: async () => {
        const row = await Promise.resolve(ownPost);
        return row;
      },
    },
  },
});

const run = protectSkill((task) => {
  if (
    task !== null &&
    typeof task === "object" &&
    "skillId" in task &&
    typeof task.skillId === "string"
  ) {
    return task.skillId;
  }
  return "";
});

function authFrom(header: string | undefined): {
  readonly clientId?: string;
  readonly scopes?: readonly string[];
} {
  if (header === "admin") {
    return {
      clientId: "admin",
      scopes: [permissions.post.read.scope, permissions.post.publish.scope],
    };
  }
  if (header === "member") {
    return {
      clientId: "member",
      scopes: [permissions.post.read.scope, permissions.post.publish.scope],
    };
  }
  return { clientId: "reader", scopes: [permissions.post.read.scope] };
}

export const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

app.get("/.well-known/agent-card.json", (c) => c.json(agentCard()));

app.get("/a2a/extended-card", async (c) => {
  const card = await extendedAgentCard(authFrom(c.req.header("authorization")));
  return c.json(card);
});

app.post("/a2a/tasks", async (c) => {
  const task: unknown = await c.req.json();
  const result = await run(task, authFrom(c.req.header("authorization")));
  if (!result.ok) {
    if (
      "wwwAuthenticate" in result &&
      typeof result.wwwAuthenticate === "string"
    ) {
      c.header("WWW-Authenticate", result.wwwAuthenticate);
    }
    return c.body(JSON.stringify(result.problem), result.status, {
      "content-type": "application/problem+json",
    });
  }
  return c.json({ ok: true });
});
