import { app } from "./app.ts";

declare const Deno: {
  serve(
    options: { readonly port: number; readonly hostname: string },
    handler: (request: Request) => Response | Promise<Response>,
  ): unknown;
  readonly env: { get(name: string): string | undefined };
};

Deno.serve(
  { port: Number(Deno.env.get("PORT")), hostname: "127.0.0.1" },
  (request) => app.fetch(request),
);
