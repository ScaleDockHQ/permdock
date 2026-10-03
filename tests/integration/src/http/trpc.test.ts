import type { Server } from "node:http";
import type { HttpCall, HttpResult } from "permdock/testing";

import { createAdaptorServer } from "@hono/node-server";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { initTRPC } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { testHttpAdapter } from "permdock/testing";
import { saasPermissions as p } from "permdock/testing/saas";
import { createPermDock, errorFormatter } from "permdock/trpc";
import { z } from "zod";

import { listen } from "../support/listen.ts";

type Context = { readonly req: Request };

const Org = z.object({ org: z.string() });
const Row = Org.extend({ id: z.string() });

const ok = (status: number, body: unknown): HttpResult => ({
  status,
  body,
});

testHttpAdapter({
  name: "permdock/trpc over fetchRequestHandler with httpBatchLink",
  skip: {
    upload: "the mount takes JSON input; uploads go through a REST route",
  },
  async mount(domain) {
    const { permdock, protect, permdockHandler } = createPermDock<Context>(
      domain.policy,
      {
        subject: (opts) =>
          domain.subject(
            opts.ctx.req.headers.get("authorization"),
            new URL(opts.ctx.req.url).pathname,
          ),
        // SAFETY: every procedure's input is an object or undefined; `org` is a string when present
        tenant: (opts) =>
          (opts.input as { readonly org?: string } | undefined)?.org ??
          domain.org(new URL(opts.ctx.req.url).pathname),
        customRoles: domain.customRoles,
        store: domain.store,
        limits: domain.limits,
      },
    );
    const t = initTRPC.context<Context>().create({ errorFormatter });
    const base = t.procedure.use(permdock());
    // SAFETY: every procedure's input is an object or undefined; `id` is a string when present
    const row = (opts: { readonly input?: unknown }) =>
      domain.project((opts.input as { readonly id?: string } | undefined)?.id);

    const router = t.router({
      project: t.router({
        get: base
          .input(Row)
          .use(protect(p.project.read, row))
          .query(({ ctx }) => ctx["permdockData"]),
        update: base
          .input(Row)
          .use(protect(p.project.update, row))
          .mutation(({ input }) => ({ id: input.id })),
        create: base
          .input(Org.extend({ body: z.unknown() }))
          .use(
            protect(
              p.project.create,
              // SAFETY: this procedure's input schema is an object with a `body` field
              (opts) => (opts.input as { readonly body?: unknown }).body,
              {
                trusted: false,
              },
            ),
          )
          .mutation(({ ctx }) => ctx["permdockData"]),
        delete: base
          .input(Row)
          .use(protect(p.project.read, row))
          .mutation(({ ctx }) => {
            ctx["permdock"].assert(p.project.delete, ctx["permdockData"]);
            return null;
          }),
      }),
      analytics: base
        .input(Org)
        .use(protect(p.analytics.read))
        .query(() => ({ ok: true })),
      apiKey: t.router({
        create: base
          .input(Org)
          .use(protect(p.apiKey.create))
          .mutation(() => ({ ok: true })),
        revokeAll: base
          .input(Org)
          .use(protect(p.apiKey.revokeAll))
          .mutation(() => null),
      }),
      admin: t.router({
        members: base
          .input(Org)
          .use(protect(p.member.list))
          .query(() => ({ members: [] })),
      }),
    });

    // SAFETY: createAdaptorServer without http2 options creates a node:http Server
    const server = createAdaptorServer({
      fetch: (request: Request) => {
        const [org, segment] = new URL(request.url).pathname
          .split("/")
          .slice(1);
        if (segment === "permdock") {
          return permdockHandler(request);
        }
        return fetchRequestHandler({
          endpoint: `/${org ?? ""}/trpc`,
          req: request,
          router,
          createContext: () => ({ req: request }),
        });
      },
    }) as Server;
    const mounted = await listen(server);

    const clients = new Map<
      string,
      ReturnType<typeof createTRPCClient<typeof router>>
    >();
    const clientFor = (call: HttpCall, origin: string) => {
      const key = JSON.stringify([call.org, call.authorization, call.approval]);
      let client = clients.get(key);
      if (client === undefined) {
        const headers: Record<string, string> = {};
        if (call.authorization !== null) {
          headers["authorization"] = call.authorization;
        }
        if (call.approval !== undefined) {
          headers["permdock-approval"] = call.approval;
        }
        client = createTRPCClient<typeof router>({
          links: [
            httpBatchLink({ url: `${origin}/${call.org}/trpc`, headers }),
          ],
        });
        clients.set(key, client);
      }
      return client;
    };
    const origin = await new Promise<string>((resolve) => {
      const address = server.address();
      resolve(
        typeof address === "object" && address !== null
          ? `http://127.0.0.1:${address.port}`
          : "",
      );
    });

    const call = async (input: HttpCall): Promise<HttpResult> => {
      const client = clientFor(input, origin);
      const { org } = input;
      try {
        switch (input.op) {
          case "project.get":
            return ok(
              200,
              await client.project.get.query({ org, id: input.id }),
            );
          case "project.update":
            return ok(
              200,
              await client.project.update.mutate({ org, id: input.id }),
            );
          case "project.create":
            return ok(
              201,
              await client.project.create.mutate({ org, body: input.body }),
            );
          case "project.delete":
            await client.project.delete.mutate({ org, id: input.id });
            return ok(204, null);
          case "project.upload":
            throw new Error("uploads are skipped for tRPC");
          case "analytics.read":
            return ok(200, await client.analytics.query({ org }));
          case "apiKey.create":
            return ok(201, await client.apiKey.create.mutate({ org }));
          case "apiKey.revokeAll":
            await client.apiKey.revokeAll.mutate({ org });
            return ok(204, null);
          case "admin.members":
            return ok(200, await client.admin.members.query({ org }));
          case "evaluations": {
            const headers = new Headers({ "content-type": "application/json" });
            if (input.authorization !== null) {
              headers.set("authorization", input.authorization);
            }
            const response = await fetch(
              `${origin}/${org}/permdock/access/v1/evaluations`,
              { method: "POST", headers, body: JSON.stringify(input.body) },
            );
            return ok(response.status, await response.json());
          }
          default: {
            const exhaustive: never = input;
            return exhaustive;
          }
        }
      } catch (error) {
        if (!(error instanceof TRPCClientError)) {
          throw error;
        }
        // SAFETY: errorFormatter above adds httpStatus to every error's data
        const data = error.data as { readonly httpStatus?: number } | undefined;
        return { status: data?.httpStatus ?? 500, body: data };
      }
    };

    return {
      call,
      ...(mounted.close === undefined ? {} : { close: mounted.close }),
    };
  },
});
