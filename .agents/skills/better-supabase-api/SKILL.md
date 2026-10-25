---
name: better-supabase-api
description: Build HTTP APIs, Edge Functions and MCP servers on Supabase with better-supabase adapters. Use when adding a route, REST resource, oRPC procedure, Edge Function, MCP tool, AI chat route, knowledge or memory, stored agent, MCP connector, eve agent, Chat SDK bot, resumable stream, third-party credential, OAuth or agent scopes, webhook, background job, cleanup cron or idempotent endpoint.
---

# APIs with better-supabase

Every adapter resolves the caller once and hands you `{ auth, db, supabase }`.
`auth.kind` is `user`, `anon`, `service` or `invalid`. For sessions, claims
and the OAuth client or agent behind a token, see the `better-supabase-auth`
skill.

## Workflow: add an endpoint

1. Pick the adapter for the runtime (table below). Setup code for each is in
   [references/adapters.md](references/adapters.md).
2. Decide who may call it with `allow`, and which scopes a delegated token
   needs with `scopes` (see below).
3. Use `db` from the handler context and return its `Result`, a plain value
   or a `Response`.
4. For a table exposed as REST, prefer `bsb.resource(...)` over hand-written
   routes, and regenerate `openapi.json` with `better-supabase spec emit openapi`.
5. Add an API test that calls the endpoint as a user and as another tenant,
   and with a delegated token that lacks the scope (the
   `better-supabase-testing` skill).

Done when the endpoint rejects callers outside `allow` and tokens without its
`scopes`, errors come back as Problem Details (no hand-built error JSON), and
`spec emit openapi --check` passes if the project has an OpenAPI file.

## Who gets in

`allow` defaults to `['user']`. Use `['user', 'anon']` for public endpoints
and `['service']` for machine callers. Rejected callers get a 401 with a
`WWW-Authenticate` header, or a 403, as Problem Details.

`scopes` limits what a delegated token may do: a token from the Supabase
OAuth server (`client_id` and `scope`) or one exchanged for an agent (an
RFC 8693 `act` chain). The guard options of `bsb.route`, `bsb.action`,
`bsb.handler` (edge) and `bsb.middleware` (Hono, oRPC) take it, next to
`allow`:

```ts
export const GET = bsb.route(
  (request, { db }) => db.customers.list({ limit: 20 }),
  { scopes: ["customers:read"] },
);
```

With `.claims(schema)` on the definition, `auth.claims` is typed in every
adapter (`c.var.auth`, `context.auth`, the edge handler's `auth`, MCP's
`ctx.auth`). Read roles from it; don't parse the claims again.

A token without the scope gets a 403 with an `insufficient_scope`
challenge. The user's own session holds no `client_id` or `act`, so `scopes`
never limits it. RLS still decides the rows: the token's `sub` is the user.

## Adapters

| Where                                           | Setup                                                                                                   | Handler                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Next.js                                         | `createNext(betterSupabase)` in `lib/supabase/server.ts`                                                | `bsb.route((req, { db }) => ...)`, `bsb.action({ input: schema }, (input, { db }) => ...)` |
| Hono                                            | `createHono(betterSupabase)`, `.use('/api/*', bsb.middleware())`                                        | `c.var.db`; `bsb.resource('customers', {...})` for REST                                    |
| oRPC                                            | `createOrpc(betterSupabase)`, `base.use(bsb.middleware())`                                              | `bsb.unwrap(context.db.customers.list(...))`                                               |
| Expo Router                                     | `createExpo(betterSupabase)`, `+middleware.ts` with `bsb.middleware()`                                  | `export const loader = bsb.loader(({ db }) => ...)`, `bsb.handler(...)` in `+api.ts`       |
| Edge Functions                                  | `createEdge(betterSupabase, { cors: true })`                                                            | `Deno.serve(bsb.handler((req, { db }) => ...))`                                            |
| MCP                                             | `createMcp(betterSupabase, { name, version, resources })`                                               | `.tool({ name, input, run: (args, { db }) => ... })`                                       |
| Node, Express, Fastify, Koa                     | `toNodeHandler`, `toExpress`, `toFastify`, `toKoa` from `better-supabase/node`                          | `res.locals.db`, `request.locals.db`, `ctx.state.db`; `guard`, `fastifyGuard`, `koaGuard`  |
| NestJS                                          | `toNestMiddleware(entries)` from `better-supabase/nestjs`                                               | `@Ctx("db") db`, `@UseGuards(guard({ roles }))`, `@UseFilters(problemFilter())`            |
| Astro                                           | `createAstro(betterSupabase)`, `export const onRequest = bsb.onRequest`                                 | `bsb.locals(Astro).db`, `bsb.guard(Astro, options)`, `bsb.action(...)`                     |
| SolidStart                                      | `createSolidStart(betterSupabase, { getRequestEvent })`, `createMiddleware(bsb.middleware)`             | `await bsb.require()` in a `"use server"` query, `bsb.action(...)`                         |
| Nuxt, Nitro 2                                   | the `better-supabase/nuxt` module, or `toH3V1(entries)` from `better-supabase/h3/v1`                    | `event.context.db`, `guard(options)`                                                       |
| H3 2, Nitro 3                                   | `toH3(entries)` from `better-supabase/h3`                                                               | `event.context.db`, `guard(options)`                                                       |
| TanStack Start, SvelteKit, React Router, Elysia | `withBetterSupabase(server)` in a bridge: `toTanStackStart`, `toSvelteKit`, `toReactRouter`, `toElysia` | the framework's context (`context.db`, `locals.db`, `context.get(key).db`)                 |

Next.js, Hono, Expo Router, SvelteKit, TanStack Start and React Router are supported adapters; Edge Functions, Node, NestJS, Astro, SolidStart, Nuxt, H3 and Elysia are community adapters with a smoke test, so prefer a supported one for a new app ([adapter tiers](https://bettersupabase.com/docs/frameworks#adapter-tiers)).

Never use `@supabase/server/adapters/*` (deprecated, removed 2026-12-01).

Don't build error JSON by hand; errors become Problem Details.

## REST resources

`defineResource` / `bsb.resource(table, { operations, list, input })` gives you
list, get, create, update and delete, with validation and paging (`{ items, page }`).
`createOpenApi(betterSupabase, { resources })` describes the same routes, and
`better-supabase spec emit openapi --check` keeps `openapi.json` in sync.
Each resource also serves `POST /<table>/page`, `/count`, `/aggregate` and
`/upsert` with the repository method's arguments as the body.

For one API over every table and block instance, use
`defineApi(betterSupabase, { info, basePath })` from `better-supabase/spec`
and serve it with `bsb.router(api, { meta: openapi })` from `createOrpc`.
Without `resources` and `blocks` it publishes everything; a map publishes
only the keys it names. Block methods are `POST /<instance>/<method>`.

Pass `pagination: "cursor"` to a resource, `defineListQuery` or an MCP table
for lists that clients read page by page: the list takes `after` instead of
`page`, returns `nextCursor` and `hasMore`, and `size` stays capped by
`maxPageSize`. The OpenAPI document and the JSON Schema describe the cursor.

## MCP servers

- Tools run as the calling user, so RLS applies to every call.
- `authorize(ctx, tool, args)` refuses a call (`{ allowed: false, reason, scopes }`; with `scopes` it is a 403 `insufficient_scope`). `visible(ctx, tool)` hides tools from `tools/list`. Put a permission or a label in a tool's `meta`; clients never see it.
- `scopes` on `createMcp` only advertises scopes. Refuse calls in `authorize`, reading `toSession(ctx.auth).delegation?.scopes`.
- Set `allowedOrigins` and `allowedHosts` (every host the server answers on, previews and local included) against DNS rebinding, and `resourceDocumentation` to a page that explains how to connect.
- On the official MCP SDK, keep its `McpServer`: `createMcpAuth(betterSupabase, { resource })` from `better-supabase/mcp/sdk` verifies the token and serves the metadata (`auth.serve(createMcpHandler(factory))`), and `withBetterSupabaseMcp(server, auth)` gives every `registerTool` callback `db`, `auth` and `bsb`. With a permission library that wraps `McpServer`, wrap with it first, then `withBetterSupabaseMcp`.

## AI chat (`add ai-chat`; `ai`, `@ai-sdk/react`, `@ai-sdk/workflow` and `workflow` as optional peers)

- Store chats with `createAiChat({ transport, service })` from `better-supabase/blocks/ai-chat`: `transport` calls as the user, `service` as the service role for assistant messages, runs and the model catalog. Never write assistant messages from the client.
- Serve the chat with `createAssistant({ streams, run, defaultModel, quota })` from `better-supabase/ai-sdk/chat`: `respond` on `POST /api/chat`, `resume` on `GET /api/chat/[id]/stream`, `stop` on `POST /api/chat/[id]/stop`. Return `streamText(...)` from `run` with the `messages`, `abortSignal` and `providerOptions` it receives, and pass `waitUntil` (`after` in Next.js) so the answer is stored after the response.
- On the client use `useAssistant({ id, messages })` from `better-supabase/ai-sdk/react`; load `messages` on the server with `toUIMessages(await aiChat.messages.path(id, { native: true }).orThrow())`.
- Models are AI Gateway `provider/model` strings checked against `ai_model_catalog`; refresh it with the `modelCatalogRefresh` job and backfill costs with `costBackfill` from `better-supabase/ai-sdk`.
- For answers that must outlive the request (long agents, approvals that wait hours), use `durableChat({ assistant, workflow, streams })` from `better-supabase/ai-sdk/workflow` with a `"use workflow"` function that calls `durableTurn(input, { runId: getWorkflowMetadata().workflowRunId, createHook, getWritable, step, agent })`. `step` is one `"use step"` function that calls `runDurableStep(serviceAiChat, name, input)`, and the agent's model is a gateway string. The route context is the assistant context; its `chats.runs` (from `createAiChat`) serves the runs. On the client use `useDurableAssistant({ id, messages, resume: chat.activeStreamId !== undefined })` from `better-supabase/ai-sdk/workflow/react`. Record a long run's progress with `chats.runs.steps.record(runId, { key, label, status })` and list undecided approvals with `chats.runs.pendingApprovals()`.
- For tenant keys, add the `ai-keys` SQL module: store the key with the credential provider first, save its `credential_ref` with `createAiKeys({ transport, service, credentials }).keys.upsert(organizationId, key)` from `better-supabase/blocks/ai-keys`, and merge `byokOptions(await providers.keys.resolve(organizationId).orThrow())` into `providerOptions.gateway`. Call `keys.removeAll(organizationId)` when a tenant is deleted. The same module tracks batches (`aiBatches({ providers })` from `better-supabase/ai-sdk/batches`, with its `pollJob`) and sandboxes (`trackedSandbox`, `sandboxes.idleStopJob`).
- For repeated model calls, add the `ai-cache` SQL module and wrap the model with `wrapLanguageModel({ model, middleware: cacheMiddleware({ cache, ttl, organizationId }) })` from `better-supabase/ai-sdk/cache`; the cache is service-role only, so create it with a service transport. Meter spend with `meterTelemetry` through `registerTelemetry` and reconcile it nightly with the `spendReconciliation` job.
- Blocks never import an AI SDK. Put SDK code in the app or an adapter subpath, and store third-party tokens as a `credential_ref`, never in a column.

## AI blocks, agents and bots

Knowledge, memory, stored agents, MCP connectors, scheduled AI tasks, the AI
SDK helpers (`better-supabase/ai-sdk/agents`, `/mcp`, `/embeddings`,
`/memory`, `/files`, `/batches`), eve and Chat SDK bots are in
[references/ai.md](references/ai.md).

## Streams, credentials and the Workflow World

Resumable output (`better-supabase/streams`, `/streams/redis`), third-party
tokens behind a `credential_ref` (`better-supabase/credentials`,
`/vercel-connect`) and the Node-only Workflow World
(`better-supabase/workflow-sdk/world`) are in
[references/streams-credentials.md](references/streams-credentials.md).

## Native and offline apps

For Expo and React Native, follow [references/expo.md](references/expo.md):
server loaders for the web, `better-supabase/client/native` on the device.
To read and write offline, run the same repositories on a PowerSync database
and upload through `bsb.db`, as in [references/powersync.md](references/powersync.md).

## Background work (`better-supabase/blocks/queue`, needs `add jobs idempotency webhook-inbox`)

- `createQueue({ sql: postgres.admin, queues: { queue_name: zodSchema } })` runs on Supabase Queues (pgmq): `enqueue(queue, payload, { context: db.$context })` in the request, then `work` or `drain` in a worker, where `const db = await bsb.forContext(job.context).orThrow()` runs the work as the enqueuing user with RLS (it fails with `forbidden` for a job without a user; use `bsb.admin(job.context)` only for work no user owns). The handler throws to retry. `schedule(name, cron, queue, payload, { timeZone })` uses pg_cron, or with `blocks.queue.options.scheduler: "drain"` a `jobs.drainRoute({ secret: process.env.CRON_SECRET, handlers })` route that Vercel Cron calls; `blocks.queue.options.backend: "table"` runs without pgmq. Queue names are lowercase letters, digits and underscores. With a service-role Supabase client instead of SQL, it uses the `pgmq_public` RPCs (no dedupe or schedules).
- `createIdempotency({ sql: postgres.admin }).handle(request, handler)` for POST endpoints that clients retry.
- `createRateLimit({ sql: postgres.admin })` limits keys that aren't claims: `check(scope, key, rule?)` for one limit, `checkAll([{ scope, key, rule? }, ...])` for several in one round trip that counts only when all allow (each limit its own scope; `blocked` names the refusing one). Answer a refusal with `rateLimited(decision)`.
- Large browser uploads: `bucket.connect(client).reserveResumable(target)` (`better-supabase/storage`) signs a TUS upload and returns `{ tusEndpoint, headers, metadata, expiresAt, bucket, path, token }`; hand `endpoint: tusEndpoint`, `headers` (`x-signature`, `x-upsert`) and `metadata` (plus `contentType`) to `tus-js-client`, so the browser needs no access token. Call `claimReserved(reservation)` afterwards, which a support session needs.
- `createWebhookInbox({ transport: sqlTransport(postgres.admin), source, secrets }).receive(request)` for webhooks; `process(handler)` later. `createInbox` is the conversation inbox (`blocks/inbox`), not this.
- Times are `Temporal.Instant`: `EnqueueOptions.runAt`, `Job.enqueuedAt`, `Job.visibleUntil`, `WebhookInboxMessage.receivedAt` and webhook timestamps.
- Schedule cleanup with pg_cron at a quiet hour: `better_supabase.purge_job_archive('<queue>')`, `purge_webhooks()`, `purge_audit_log()`, `purge_idempotency_keys()`, `purge_rate_limits()`, `purge_outbox()`, `purge_notifications()` and `purge_webhook_deliveries()`, for the modules you installed. Only `service_role` can execute them.
- Audit a table with `better_supabase.audit('public.t', redact => '{secret}', event_prefix => 't')`. Each call replaces all of the table's settings, so a second call without `ignore` and `redact` clears them; read `audit_settings('public.t')` first when another package also registers the table; record non-row events with `better_supabase.audit_event(event_type, ...)` and an `idempotency_key`. For per-tenant retention, write an `audit_retention(tenant)` SQL function or call `purgeAuditLog(sql, { retention })` from `better-supabase/blocks/audit`, which also has `auditListQuery` and `exportAuditLog` (NDJSON or OCSF). `upgrade` writes a pgTAP file per audited table, and doctor BS315 lists tables without the trigger; exempt the rest with `blocks.audit.options.exempt` globs.
- For a "view as user" support mode, add the `impersonation` SQL module, pass `support: supportSessions({ store: sqlSupportStore(postgres) })` to `createServer`, call `bsb.startSupport({ targetUserId, reason })` and `bsb.stopSupport()` from server actions, and show a banner with `useSupportSession()`. Sessions are read-only by default; grant admins the `support.start` platform permission. Realtime in a support session (or with httpOnly cookies) goes through `export const { GET, POST } = realtimeRelay(bsb, { topics: [myTopic, liveRelayTopic], postgres })` from `better-supabase/server`, which checks each topic's `realtime.messages` policies as the viewed user; pass `realtime={useRealtimeRelay("/api/realtime")}` to `<BetterSupabaseProvider>` (or `relayRealtimeClient(url)` / `relayTopicPort(url)` from `better-supabase/realtime`) so `subscribe`, `useBroadcast`, `usePresence` and `useLiveQuery` work unchanged. Never subscribe in the browser with the admin's own client during a support session.
- For teams, add the `organizations` and `invitations` SQL modules and call them through `createOrganizations({ transport: sqlTransport(postgres.asUser(claims)), events: betterSupabase.events, onInvite })` from `better-supabase/blocks/organizations`. Send the invitation email in `onInvite`, show `previewInvitation(token)` on the accept page, and switch with `organizations.switch(id)`, refreshing the session when it returns `refresh: true`. Errors carry codes such as `ORGANIZATION_SLUG_TAKEN` in `hint`. Tables your schema already has are detected and kept; map other names with `tables` and `columns`.
- For user profiles, add the `profiles` SQL module: sign-up creates the row from auth metadata with a unique username and mirrors the email; users update only the `updatable` columns. An existing `profiles` table is detected and kept: the block adds only the columns it lacks, `tables` and `columns` map other names, and `syncTrigger: false` leaves profile creation to your own trigger. Use `avatarBucket()` and `organizationLogoBucket()` from `better-supabase/storage` for uploads; `policy: { access: { read, write } }` checks any bucket through the access contract.
- For events other systems must see, add the `outbox` SQL module and write events with `emit_event(type, payload, subject, tenant, key)` inside the same transaction as the change (the SQL modules emit theirs automatically). Relay them with `createOutbox({ transport: sqlTransport(postgres.admin), source }).relayRoute({ secret, consumers: { name: httpSink(url) } })` from `better-supabase/blocks/outbox` after `outbox.register(name, { types })`. Delivery is at least once; receivers deduplicate on the CloudEvent `id`.
- For in-app notifications, add the `notifications` SQL module and send with `createNotifications({ transport: sqlTransport(postgres.asUser(claims)), types })` from `better-supabase/blocks/notifications`, where `types` maps each notification type to a Standard Schema for its data. Pass a `key` so retries don't notify twice. Show them with `useNotifications({ topic, load })` from the `@better-supabase/use-notifications` registry item (`npx shadcn add @better-supabase/use-notifications`); the topic defaults to `notifications:{userId}`. For email or push, pass `channels` and call `notifications.deliver()` from a cron route with a service connection.
- For a support inbox, add the `inbox` SQL module (with `jobs` for bot and delivery jobs) and call `createInbox({ transport: sqlTransport(postgres.asUser(claims)) })` from `better-supabase/blocks/inbox`; staff need `inbox.read`, `inbox.reply`, `inbox.assign` or `inbox.manage`. Keep lists and threads live with `useInbox`, `useConversation` and `useInboxWidget` from the `@better-supabase/use-inbox` registry item, each loading through a server action. For bots and channels, add `chat-sdk-state` and use `better-supabase/chat-sdk`: `createSupabaseState` as the Chat SDK state, `inboxAdapter` for the in-app widget, `webhook`, `inboundHandler` and `deliver` for Slack, WhatsApp or SMS, and `maintain` from a cron route. Platform tokens stay behind a `credential_ref`. Docs: `https://bettersupabase.com/docs/blocks/inbox.md` and `https://bettersupabase.com/docs/chat-sdk.md`.
- For webhooks to customers' endpoints, add the `webhooks-out` SQL module and publish with `createWebhooks({ transport: sqlTransport(postgres.admin) }).publish({ type, data, tenant, id })` from `better-supabase/blocks/webhooks`. Pass an `id` so retries don't send twice. Send with `webhooks.deliverRoute({ secret: process.env.CRON_SECRET })` from a cron route; deliveries are signed with Standard Webhooks and only go to public HTTPS URLs by default.
- Each SaaS block below is an SQL module of the same name plus `better-supabase/blocks/<name>`, called through `sqlTransport(postgres.asUser(claims))` for user actions and `postgres.admin` for service work; errors carry a code in `hint`. Its docs page is `https://bettersupabase.com/docs/blocks/<name>.md`.
  - `api-keys`: `createApiKeys`, and `auth: { resolvers: [apiKeyResolver({ keys })] }` in the adapter so key callers get `auth.kind === "apiKey"`. Show a new key once; only its hash is stored.
  - `settings`: `defineSettings` with a Standard Schema per key, read and written through `createSettings({ settings, transport })`; `usage`: `createUsage` with a `key` per increment, `within_quota` in policies; `billing`: `createBilling` with `stripe` as an optional peer; `flags`: `createFlagsProvider` for OpenFeature, `flag_enabled(key)` in policies.
  - `comments` (a record's messaging conversation; needs `tenant`, `subjects` and `messaging`, keys `messages.read`, `messages.send`, `messages.moderate`, events `message.*`), `activity` (`activitySink` as an outbox consumer, `createTimeline().list(subject?)` for the feed and a record's timeline), `attachments` (signed URLs, served only after a scan), `data-lifecycle` (exports, organization deletion with a grace period), `sso` (verified domains, SAML, SCIM), `onboarding` (`defineChecklist`, `createOnboarding`, `useOnboarding`), `waitlist` (`createWaitlist`, `waitlistHook` for invite-only sign-up) and `announcements` (`createAnnouncements`, `useAnnouncements`).
  - `workflows`: `createWorkflows` for the run registry of any engine (`runs.list`, `runs.requestCancel`), schedules and admission whose `tick` hands each start to an engine, and `useWorkflowRuns` from the `@better-supabase/use-workflows` registry item. With the Workflow SDK, add the `workflow-sdk` module, set `WORKFLOW_TARGET_WORLD=better-supabase/workflow-sdk/world`, start runs with `startFor(ctx, workflow, args)` from `better-supabase/workflow-sdk` so members see them under RLS, pass `workflowStarter({ name: workflow }, { runAs: { publisher, permissions } })` to `tick` (schedules and `startOnEvent` run as that publisher, capped to those keys), and check `authorizeHook(token, ctx)` before `resumeHook`. The World is Node-only (`https://bettersupabase.com/docs/blocks/workflow-sdk.md`).
  - `automations`: register every action once with `createActionRegistry([...])` (`notifyAction`, `workflowAction`, the target blocks' conversion actions such as `taskFromConversationAction`, your own `defineAction`), pass it to `createRuleDispatcher({ actions })`, and consume the outbox with `createRuleSink`. Blocks ship default automations (inbox to tasks, hiring to employees, quotes to orders) that organizations turn off, edit or `resetDefault`, and `blocks.automations.options.enable` or `disable` (keys such as `quotes.quote_to_order`) sets whether a default ships on; there is no `createFlows`. Block timers (SLA, sequences, AI schedules, workflow schedules, content publishing) run from `blockSchedules` and `blockTickHandler` on the queue (`https://bettersupabase.com/docs/blocks/automations.md`).
  - `workflow-editor`: `createWorkflowEditor` with `compile: compileGraph` and `start: graphStarter({ steps, executor })` from `better-supabase/workflow-sdk/builder`, and a service-role `service` transport for webhooks, `credentials.resolve` and `nodeRuns.record`. A definition has no event trigger: an automation's `workflow` action starts it on an outbox event. Call `steps.sync()` at deploy time so publishing accepts the steps. Wrap each step in `nodeRunReporter` for the canvas status, and read it with `useWorkflowCanvasRun` (`https://bettersupabase.com/docs/blocks/workflow-editor.md`).

Done when a failing job is retried and then archived after `maxAttempts`,
a replayed webhook or POST doesn't run twice, and each block table has a purge
schedule.

## Direct Postgres on the server

- `createPostgres()` opens a pool; `createPostgres({ pool })` runs on an existing `pg.Pool`. `asUser` and `anon` transactions get Supabase's role timeouts (8 s and 3 s); `statementTimeout` takes a number or `{ admin, authenticated, anon }`.
- `create` and `upsert` with an array split inserts past 65,535 bind parameters into several statements in one transaction, so large batches don't need manual chunking.
- In serverless functions, connect through the transaction pooler (port 6543), not a direct connection.

## Testing

Sign tokens with `signLocalJwt` or `asUser` from `better-supabase/testing`;
the adapter verifies them against the local JWKS. See the `better-supabase-testing` skill.

Docs: https://bettersupabase.com/docs/frameworks.md lists every adapter;
each has a page such as https://bettersupabase.com/docs/frameworks/hono.md,
https://bettersupabase.com/docs/frontend/powersync.md,
https://bettersupabase.com/docs/blocks/queue.md,
https://bettersupabase.com/docs/ai-sdk/chat.md,
https://bettersupabase.com/docs/ai-sdk/workflow.md and
https://bettersupabase.com/docs/auth/postgres.md.
