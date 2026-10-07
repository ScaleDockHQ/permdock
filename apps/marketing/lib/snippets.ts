export type CodeSnippet = {
  readonly id: string;
  readonly label: string;
  readonly filename: string;
  readonly language: string;
  readonly code: string;
};

export const heroSnippet: CodeSnippet = {
  id: "hero",
  label: "decide",
  filename: "decide.ts",
  language: "ts",
  code: `import { createPermDock } from 'permdock'
import { permissions, policy } from './policy'

const permdock = await createPermDock(policy, user)

permdock.can(permissions.post.update, post)
permdock.decide(permissions.post.delete, post)
// { outcome: 'granted' | 'denied' | 'approval-required', ... }
`,
};

export const surfaceSnippets: readonly CodeSnippet[] = [
  {
    id: "next",
    label: "Next.js",
    filename: "permdock/server.ts",
    language: "ts",
    code: `import { createPermDock } from 'permdock/next'

export const { getPermDock, PermDockProvider, permdockHandler } =
  createPermDock(policy, {
    subject: async () => getUser(await cookies()),
  })

const permdock = await getPermDock()
permdock.assert(permissions.post.update, post)
`,
  },
  {
    id: "react",
    label: "React",
    filename: "edit-button.tsx",
    language: "tsx",
    code: `import { PermDockProvider, Protected } from 'permdock/react'

<PermDockProvider snapshot={snapshot} endpoint="/api/permdock">
  <Protected permission={permissions.post.update} data={post} fallback={<Locked />}>
    <EditButton />
  </Protected>
</PermDockProvider>
`,
  },
  {
    id: "hono",
    label: "Hono",
    filename: "app.ts",
    language: "ts",
    code: `import { createPermDock } from 'permdock/hono'

export const { permdock, protect } = createPermDock(policy, {
  subject: (c) => c.get('user'),
})

app.delete(
  '/posts/:id',
  protect(permissions.post.delete, (c) => loadPost(c.req.param('id'))),
  handler,
)
`,
  },
  {
    id: "mcp",
    label: "MCP",
    filename: "server.ts",
    language: "ts",
    code: `import { createPermDock } from 'permdock/mcp'

const { protectServer } = createPermDock(policy, {
  subject: (authInfo) => userFrom(authInfo),
})

protectServer(server).registerTool(
  'delete_post',
  { permission: permissions.post.delete, inputSchema, data: (args) => loadPost(args.id) },
  handler,
)
`,
  },
  {
    id: "ai-sdk",
    label: "AI SDK",
    filename: "agent.ts",
    language: "ts",
    code: `import { createPermDock } from 'permdock/ai-sdk'

const { toolApproval } = createPermDock(policy, {
  subject: ({ runtimeContext }) => runtimeContext.user,
  tools: { delete_post: { permission: permissions.post.delete, data: (args) => loadPost(args.id) } },
})

generateText({ model, tools, toolApproval })
`,
  },
  {
    id: "rls",
    label: "RLS",
    filename: "terminal",
    language: "bash",
    code: `permdock rls generate --target drizzle --dialect supabase
permdock rls import --db $DATABASE_URL --out src/permissions.generated.ts
permdock rls verify --db $DATABASE_URL
`,
  },
];

export const portableSnippets: readonly CodeSnippet[] = [
  {
    id: "memory",
    label: "In memory",
    filename: "filter.ts",
    language: "ts",
    code: `allow(permissions.post.update, { to: relation(permissions.post, 'author') })

permdock.filter(permissions.post.update, posts)
`,
  },
  {
    id: "drizzle",
    label: "Drizzle",
    filename: "where.ts",
    language: "ts",
    code: `import { toWhere } from 'permdock/drizzle'

db.select().from(posts).where(permdock.where(permissions.post.read))
`,
  },
  {
    id: "rls-sql",
    label: "Postgres RLS",
    filename: "posts.sql",
    language: "sql",
    code: `CREATE POLICY post_update_author ON posts
  FOR UPDATE
  USING (author_id = (select permdock.permdock_user_id()));
`,
  },
];
