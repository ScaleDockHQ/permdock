# AI blocks, agents and SDK adapters

The AI blocks store data and never import an AI SDK. The SDK code lives in
the adapter subpaths (`better-supabase/ai-sdk/*`, `/chat-sdk`, `/eve`) or in
the app. Each block takes `transport` (calls as the user) and, where it
writes on the user's behalf, `service` (calls as the service role). Use
`rpcTransport(supabase)` over PostgREST or `sqlTransport(postgres.asUser(claims))`
over direct Postgres. Its docs page is
`https://bettersupabase.com/docs/blocks/<name>.md`.

## Knowledge and memory

```bash
pnpm better-supabase sql add knowledge memory   # adds tenant, access and vector-search
```

```ts
import { embedWith } from "better-supabase/ai-sdk/embeddings";
import {
  createKnowledge,
  rpcTransport,
} from "better-supabase/blocks/knowledge";
import { createMemory } from "better-supabase/blocks/memory";

const embedder = embedWith("openai/text-embedding-3-small");
const knowledge = createKnowledge({
  transport: rpcTransport(supabase),
  service: rpcTransport(admin),
  embedder,
});
const memory = createMemory({
  transport: rpcTransport(supabase),
  service: rpcTransport(admin),
  embedder,
});
```

- Ingest with `knowledge.ingest.text(organizationId, { title, text, source })`
  and search with `knowledge.search(organizationId, query, { scopes, k })`.
  A scope is `organization`, `user`, `agent` or `chat` (with an `id`).
- Give the model the knowledge with `searchTool(knowledge, organizationId, { scopes, onHits })`
  and cite with `toSourceParts(hits)`; rerank with `rerankWith(model, { topN })`.
  `supabaseEmbed` uses Supabase's built-in model instead of a gateway model.
- Memory has files (`memory.run(organizationId, { command, path, ... })`),
  archival facts (`memory.archival.save` and `.search`) and versioned
  documents (`memory.documents.read` and `.write` with `expectedVersion`).
- In a chat route, from `better-supabase/ai-sdk/memory`: `withMemory(instructions, memory, organizationId)`
  adds the core memory, `memoryTool` and `recallTool` are the tools, and
  `anthropicMemory(anthropic.tools, memory, organizationId)` backs
  Anthropic's built-in memory tool. Run `extractMemories({ model, memory })`
  as a job handler with a service-role `memory`.

## Agents, connectors and scheduled tasks

```bash
pnpm better-supabase sql add agents connectors ai-tasks
```

- `createAgents({ transport })` stores assistants: `agents.create(organizationId, { slug, name, instructions, tools, knowledgeScopes })`,
  then `agents.publish(id, "organization")`.
- Run a stored agent with `createAgentRuntime({ agent, model, tools, policies, knowledge, instructions })`
  from `better-supabase/ai-sdk/agents`, then `runtime.stream({ messages })`.
  Wrap the model with `moderationMiddleware({ chats, organizationId, chatId, check })`
  to check input and output; a blocked turn throws `ModerationBlockedError`.
- `createConnectors({ transport, service, credentials })` stores MCP servers
  per organization. OAuth servers get one grant per user behind a
  `credential_ref`. From `better-supabase/ai-sdk/mcp`: `authorizeConnector`
  starts the OAuth flow, `completeConnector` finishes it on the callback
  route, and `connectAll(servers, { connectors, userId, vault, credentials, chatKey })`
  returns `{ tools, skipped, close }`. Call `close()` in a `finally`.
  Review changed tool lists with `connectors.fingerprints.check`, `.approve`
  and `.reject`.
- `createAiTasks({ transport, service, run })` stores scheduled prompts with
  a `cron` and a `timezone`. `tick()` queues the due runs (handle them with
  `runJob()` on the `ai_task_run` queue when the `jobs` module is
  installed); without jobs, call `drain()` from a cron route.

## Files, cache and batches

- `aiFileDownload(files)` as `experimental_download` in `streamText` reads
  Storage file parts; `saveGeneratedFiles(files, images, { organizationId, ownerId, chatId })`
  stores generated images; `providerFile(files, fileId, provider, upload)`
  caches a provider's file id. All from `better-supabase/ai-sdk/files`.
- `aiBatches({ providers })` from `better-supabase/ai-sdk/batches` starts a
  batch per tenant with `.start({ organizationId, userId }, { requests })`,
  polls it with the `pollJob()` handler and pages results with `.results(batchId, { after, limit })`.

## eve (Node only)

```bash
pnpm add eve @workflow/world @workflow/world-postgres pg
pnpm better-supabase sql add workflow-sdk-world ai-chat memory knowledge credentials inbox
```

Set `experimental.workflow.world` to `"better-supabase/workflow-sdk/world"`
in `defineAgent`, then use the helpers from `better-supabase/eve`:

| Helper                    | Where it goes                          | What it does                                            |
| ------------------------- | -------------------------------------- | ------------------------------------------------------- |
| `supabaseAuth({ env })`   | `eveChannel({ auth: [...] })`          | signs eve routes in with the Supabase session           |
| `credentialAuth(...)`     | a connection's `auth`                  | resolves the connection's token from a `credential_ref` |
| `supabaseMemory(...)`     | `defineMemoryProvider(...)`            | backs eve memory with the memory and knowledge blocks   |
| `supabaseDocumentBackend` | `fileMemory({ backend })`              | stores file memory in `memory_documents`                |
| `persistSessions(...)`    | `defineHook({ events })`               | copies sessions into the AI chat tables                 |
| `routeInbox(...)`         | `chatSdkChannel()` over `inboxAdapter` | hands inbox conversations in bot mode to eve            |

## Chat SDK bots

```bash
pnpm add chat
pnpm better-supabase sql add chat-sdk-state inbox
```

From `better-supabase/chat-sdk`: `createSupabaseState(...)` is the Chat SDK
state adapter on Postgres, `inboxAdapter(...)` answers in the in-app widget,
`webhook(...)` receives platform webhooks, `inboundHandler(...).drain()`
replays them, `deliver(...)` sends staff replies and `maintain(...)` runs on
a cron. Mirror platform messages into the inbox with
`handler.mirror(thread, message)`. Platform adapters such as
`@chat-adapter/slack` are the app's own dependencies.

Docs: https://bettersupabase.com/docs/ai-sdk.md (and `agents`, `mcp`,
`embeddings`, `memory`, `files`, `batches` under `/docs/ai-sdk/`),
https://bettersupabase.com/docs/eve.md and
https://bettersupabase.com/docs/chat-sdk.md.
