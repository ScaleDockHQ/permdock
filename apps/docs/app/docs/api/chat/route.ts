import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  tool,
} from 'ai';

import { pageInput, parseChatRequest, searchInput } from '@/lib/ask-ai';
import { docsTools } from '@/lib/docs-tools';

const model = 'anthropic/claude-sonnet-5.5';
const searchLimit = 8;

const instructions = `You answer questions about PermDock, a TypeScript authorization library, using only its documentation.
Call search_docs to find relevant pages, then get_page to read them before you answer.
Cite every page you rely on as a Markdown link to its URL.
If the documentation does not answer the question, say so instead of guessing.
Keep answers short and show code in fenced blocks.`;

function problem(status: number, detail: string): Response {
  return Response.json(
    { title: 'Invalid chat request', status, detail },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problem(400, 'The body is not JSON.');
  }
  const parsed = await parseChatRequest(body);
  if (!parsed.ok) {
    return problem(parsed.status, parsed.detail);
  }

  const docs = docsTools();
  const result = streamText({
    model,
    instructions,
    messages: await convertToModelMessages(parsed.history),
    tools: {
      search_docs: tool({
        description:
          'Search the PermDock documentation. Returns page titles, descriptions and URLs.',
        inputSchema: searchInput,
        execute: ({ query }) => docs.search(query, searchLimit),
      }),
      get_page: tool({
        description:
          'Read one documentation page as Markdown, by its URL path such as /docs/concepts/decisions.',
        inputSchema: pageInput,
        execute: async ({ path }) =>
          (await docs.getPage(path)) ?? `No documentation page at ${path}.`,
      }),
    },
    stopWhen: isStepCount(6),
    maxOutputTokens: 2000,
    telemetry: { functionId: 'docs-ask-ai' },
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}
