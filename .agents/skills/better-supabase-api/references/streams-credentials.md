# Streams, credentials and the Workflow World

## Resumable streams

Store long output (a chat answer, a workflow's progress) so a client that
reconnects reads the rest instead of starting over.

```bash
pnpm better-supabase sql add streams
```

```ts
import {
  postgresStreamStore,
  resumeFromStore,
  sqlTransport,
  teeToStore,
} from "better-supabase/streams";

const streams = postgresStreamStore({
  transport: sqlTransport(postgres.asService()),
});

// POST: send the output and store it at the same time.
const { stream, persisted } = teeToStore(streams, chatId, output, {
  owner: userId,
  kind: "chat",
  onCancel: () => controller.abort(),
});
after(() => persisted);

// GET: resume from the last chunk the client has.
const rest = await resumeFromStore(streams, id, { fromIdx }).orThrow();
if (rest === undefined) return new Response(null, { status: 204 });
```

For Redis, `redisStreamStore({ url: process.env.REDIS_URL })` from
`better-supabase/streams/redis` (add `redis`, or pass your own client). Keep
`persisted` alive with `after` or `waitUntil`, or the stored copy stops
when the response ends.

## Credentials

Third-party tokens never go in a column. A row holds a `credential_ref`
(`{ provider, secret, scope }`) and a `CredentialProvider` resolves it.

```bash
pnpm better-supabase sql add credentials
```

```ts
import {
  sqlTransport,
  subjectFor,
  vaultCredentials,
} from "better-supabase/credentials";

export const bs = createServer(betterSupabase, {
  credentials: vaultCredentials({
    transport: sqlTransport(postgres.asService()),
  }),
});

// In a handler:
const subject = subjectFor(ctx);
if (ctx.credentials === undefined || subject === undefined)
  return unauthorized();
const token = await ctx.credentials
  .getToken(row.credential_ref, { subject })
  .orThrow();
await fetch(url, { headers: token.headers });
```

- On Vercel Connect, pass `vercelConnectCredentials()` from
  `better-supabase/vercel-connect` instead (add `@vercel/connect`).
- Check a custom provider with `testCredentialProvider` from
  `better-supabase/testing`.

## The Workflow World on Supabase (Node only)

```bash
pnpm better-supabase sql add workflow-sdk-world   # adds workflows and jobs
pnpm add workflow @workflow/world @workflow/world-postgres pg
```

```bash title=".env"
WORKFLOW_TARGET_WORLD=better-supabase/workflow-sdk/world
SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

The entry's default export reads its options from the environment, so
setting `WORKFLOW_TARGET_WORLD` is enough. To build it in code, call
`createSupabaseWorld({ connectionString, delivery: "pg_net" })`. The World
imports `pg` and Node built-ins: never import it from an edge or browser
entry.

From `better-supabase/workflow-sdk`, which runs anywhere: `startFor(ctx, workflow, args)`
starts a run members see under RLS, `authorizeHook(token, ctx)` checks a
caller before `resumeHook`, `protectWebHandler(handler, key, { can })` refuses callers before a workflow UI route or a run's stream and
`workflowStarter({ name: workflow })` hands scheduled starts from the
`workflows` block to the SDK.

Docs: https://bettersupabase.com/docs/blocks/streams.md,
https://bettersupabase.com/docs/extending/credentials.md and
https://bettersupabase.com/docs/blocks/workflow-sdk.md.
