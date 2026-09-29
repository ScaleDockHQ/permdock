import type { UIMessage } from 'ai';

import {
  findOrg,
  findProject,
  handleSaasRoute,
  projectsOf,
  readSession,
  removeProject,
  saasSubject,
} from '@permdock/e2e-saas-kit';
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  tool,
  toUIMessageStream,
  wrapLanguageModel,
} from 'ai';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPermDock } from 'permdock/ai-sdk';
import { approvalsHandler, memoryApprovalStore } from 'permdock/approvals';
import { saasPolicy } from 'permdock/testing/saas';
import { saasPermissions as p } from 'permdock/testing/saas/permissions';
import { z } from 'zod';

import { scriptedModel } from './model.ts';

const ORG = 'acme';
const PORT = Number(process.env.PORT ?? 3506);
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const client = fileURLToPath(new URL('../../dist', import.meta.url));
/** Signs approval requests so a client cannot forge one; per process. */
const approvalSecret = randomBytes(32);

let approvals = memoryApprovalStore();

async function subjectOf(request: Request) {
  return saasSubject(await readSession(request.headers.get('cookie')), ORG);
}

const byId = z.object({ id: z.string() });

const tools = {
  list_projects: tool({
    description: 'List the org’s projects',
    inputSchema: z.object({}),
    execute: () => projectsOf(ORG).map((row) => row.id),
  }),
  delete_project: tool({
    description: 'Delete a project',
    inputSchema: byId,
    execute: ({ id }) => {
      removeProject(id);
      return { deleted: id };
    },
  }),
  revoke_api_keys: tool({
    description: 'Revoke every API key of the org',
    inputSchema: z.object({}),
    execute: () => ({ revoked: true }),
  }),
};

async function chat(request: Request): Promise<Response> {
  const subject = await subjectOf(request);
  if (subject === null) {
    return new Response(null, { status: 401 });
  }
  const body = (await request.json()) as { readonly messages?: UIMessage[] };
  const permdock = createPermDock(saasPolicy, {
    subject: () => subject,
    actor: () => ({ id: 'chat-assistant', kind: 'ai-sdk' }),
    delegation: () => ({
      scopes: [
        p.project.list.scope,
        p.project.delete.scope,
        p.apiKey.revokeAll.scope,
      ],
    }),
    tenant: ORG,
    tools: {
      list_projects: { permission: p.project.list },
      delete_project: {
        permission: p.project.delete,
        data: (input) => {
          const parsed = byId.safeParse(input);
          return parsed.success ? (findProject(parsed.data.id) ?? null) : null;
        },
      },
      revoke_api_keys: { permission: p.apiKey.revokeAll },
    },
    store: approvals,
    customRoles: {
      rolesFor: (tenant) => [...(findOrg(tenant)?.customRoles ?? [])],
    },
  });
  const result = streamText({
    model: wrapLanguageModel({
      model: scriptedModel(),
      middleware: permdock.capabilityMiddleware({}),
    }),
    messages: await convertToModelMessages(body.messages ?? [], { tools }),
    tools,
    toolApproval: permdock.toolApproval,
    experimental_toolApprovalSecret: approvalSecret,
    stopWhen: stepCountIs(4),
  });
  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream, tools }),
  });
}

async function route(request: Request): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path === '/api/chat' && request.method === 'POST') {
    return chat(request);
  }
  if (path === '/api/me') {
    const subject = await subjectOf(request);
    return Response.json({ user: subject?.principal?.id ?? null });
  }
  if (path.startsWith('/api/approvals/')) {
    return approvalsHandler(approvals, {
      subject: subjectOf,
      requireDistinctApprover: true,
    })(request);
  }
  const kit = await handleSaasRoute(request);
  if (path === '/api/test/reset' && kit?.ok === true) {
    approvals = memoryApprovalStore();
  }
  return kit;
}

const TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
};

function serveStatic(pathname: string, res: ServerResponse): boolean {
  const file = normalize(
    join(client, pathname === '/' ? 'index.html' : pathname),
  );
  const target =
    file.startsWith(client) && existsSync(file) && statSync(file).isFile()
      ? file
      : pathname.startsWith('/assets/')
        ? undefined
        : join(client, 'index.html');
  if (target === undefined) {
    return false;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
  });
  createReadStream(target).pipe(res);
  return true;
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) {
        headers.append(key, item);
      }
    }
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return new Request(new URL(req.url ?? '/', ORIGIN), {
    method: req.method ?? 'GET',
    headers,
    ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
  });
}

async function send(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of response.headers) {
    if (key !== 'set-cookie') {
      headers[key] = value;
    }
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) {
    headers['set-cookie'] = cookies;
  }
  res.writeHead(response.status, headers);
  if (response.body !== null) {
    for await (const chunk of response.body) {
      res.write(chunk);
    }
  }
  res.end();
}

createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', ORIGIN).pathname;
  if (
    !pathname.startsWith('/api/') &&
    req.method === 'GET' &&
    serveStatic(pathname, res)
  ) {
    return;
  }
  toRequest(req)
    .then(route)
    .then((response) =>
      send(response ?? new Response(null, { status: 404 }), res),
    )
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : 'error'}\n`,
      );
      res.statusCode = 500;
      res.end();
    });
}).listen(PORT, '127.0.0.1');
