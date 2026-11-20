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
pnpm better-supabase add knowledge memory   # adds tenant, access and vector-search
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
pnpm better-supabase add agents connectors ai-schedules
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
- `createAiSchedules({ transport, service, run })` stores scheduled prompts with
  a `cron` and a `timezone`. `tick()` queues the due runs (handle them with
  `runJob()` on the `ai_task_run` queue when the `queue` module is
  installed); without jobs, call `drain()` from a cron route.

## AI SDK 7 modules

All from `better-supabase/ai-sdk` or its subpaths; the blocks never import the SDK.

- Messages: `toUIMessage`, `fromUIMessage` and `validUIMessages` convert between
  the ai-chat rows and AI SDK 7 `UIMessage`s (parts are stored as they are).
  `fromModelMessages` stores a model's response messages, with approvals and sources.
- Chat route: `createAssistant({ chats, model, ... })` from `ai-sdk/chat` builds
  the POST, stop and resume handlers. `useAssistant` from `ai-sdk/react` calls
  the server's stop endpoint before it stops the local stream.
  `createCompletionRoute` and `createObjectRoute` settle `onFinish` when the
  request aborts.
- Durable chats: `durableChat`, `durableTurn` and `durableSteps` from
  `ai-sdk/workflow` run a turn in a Workflow SDK run with approvals as hooks.
  `durableTransport` and `useDurableAssistant` (`ai-sdk/workflow-react`) take
  `transportOptions` (the `WorkflowChatTransport` options except `api`).
  `createWorkflowAgentRuntime` builds a `WorkflowAgent` from an agent row;
  `toolApprovalSecret: { environmentVariable }` signs approvals.
- Telemetry: `meterTelemetry({ meters })` is an AI SDK 7 `Telemetry` integration
  that meters per tenant, keyed on the response id. A per-call `integrations`
  list replaces the registered ones. `createAgentRuntime` exposes the tenant
  with `includeRuntimeContext`; a `generateText` call you make needs the same.
- Agents: `createAgentRuntime` takes `settings` (other `ToolLoopAgent`
  settings), `prepareCall`, `prepareStep`, `compact` (`pruneMessages` options),
  `telemetry` and `toolApprovalSecret`. `connectTools` takes `maxRetries` and
  `askUnlessReadOnly`.
- Knowledge: an `Embedder` with `apiVersion: 2` returns `{ embeddings, usage }`
  (`embedWith` does); version 1 still works. `createKnowledge` takes `dimensions`
  and `priorityOrder`, and hits carry `chunkId` and `organizationId`.
  `searchTool` is `strict` and takes `modelOutput: { maxCharacters }`.
- Guardrails: `guardrailsMiddleware(guardrails, { agent })` is a
  `LanguageModelMiddleware` for `wrapLanguageModel`: it refuses or redacts the
  last user message, then checks the answer and holds a streamed text block
  until `text-end`. The block's text helper is `guardText`.

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
pnpm better-supabase add workflow-sdk ai-chat memory knowledge credentials inbox
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
pnpm better-supabase add chat-sdk-state inbox
```

From `better-supabase/chat-sdk`: `createSupabaseState(...)` is the Chat SDK
state adapter on Postgres, `inboxAdapter(...)` answers in the in-app widget,
`webhook(...)` receives platform webhooks, `inboundHandler(...).drain()`
replays them, `deliver(...)` sends staff replies and `maintain(...)` runs on
a cron. Mirror platform messages into the inbox with
`handler.mirror(thread, message)`. Platform adapters such as
`@chat-adapter/slack` are the app's own dependencies.

`webhook({ sink })` stores the raw request in a durable sink such as the
queue block's `createWebhookInbox()`; a worker replays it with
`handler.process(chatEventOf(message))`. `inboxStore(inbox)` is the default
`ChatInboundStore`, so `inboundHandler`, `deliver` and `maintain` also take
your own store. `capabilitiesOf(adapterName)` reads an adapter's features and
needs the optional peer `@chat-adapter/catalog`. `inboxAdapter` handles
actions, reactions, stop actions, file upload and `ai_generated` metadata.
The `chat-sdk-state` module is version 2 (`bigint` TTLs): re-run
`better-supabase add chat-sdk-state` and apply the migration to upgrade.

Inbox thread ids are `inbox:<inboxId>:<conversationId>`; build and read them
with `inboxThreadId` and `decodeInboxThreadId`, never by string slicing. Pass
`waitUntil` (Next.js `after`) in the options of `bot.webhooks.inbox(request,
options)` so the drain returns before the bot answers. Adapter
calls throw `ChatError` (a `RateLimitError` for `rate_limited`) with the
`DbError` as `cause`, and `deliver` retries a platform `RATE_LIMITED` reply
after its `retryAfterMs`.

Embeddings and files: `embeddingCacheMiddleware` caches embeddings, `rerankHits`
reranks, `uploadToProvider` and `providerFileParts` reuse provider file
references, and `renderAutoEmbedding` (from `better-supabase/sql`) with
`embeddingWorker` keeps a table's vector column current through pgmq, pg_net and
pg_cron. `syncSkill` uploads agent skills once per content hash.
`better-supabase/json-render` stores a streamed UI spec as one part
(`assistant({ parts: { compact: collapseSpecParts } })`). `postgresMcpEventStore`
keeps MCP event subscriptions in Vault, `aiTranscriber` feeds the activities
block, `realtimeTokenRoute` guards realtime tokens and `toolSearchFrom` ranks
deferred tools from a catalog.

Docs: https://bettersupabase.com/docs/ai-sdk.md (and `agents`, `mcp`,
`embeddings`, `memory`, `files`, `batches` under `/docs/ai-sdk/`),
https://bettersupabase.com/docs/eve.md and
https://bettersupabase.com/docs/chat-sdk.md.
