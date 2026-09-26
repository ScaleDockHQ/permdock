import { app } from './app.ts';
import { elysia } from './elysia.ts';

declare const Bun: {
  serve(options: {
    readonly port: number;
    readonly hostname: string;
    readonly fetch: (request: Request) => Response | Promise<Response>;
  }): unknown;
};

Bun.serve({
  port: Number(process.env.PORT),
  hostname: '127.0.0.1',
  fetch: (request) =>
    new URL(request.url).pathname.startsWith('/elysia/')
      ? elysia.handle(request)
      : app.fetch(request),
});
