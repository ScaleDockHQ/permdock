import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { createServer } from "node:http";
import { onTestFinished } from "vitest";

export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * Serves `handler` (a Node handler or an Express app) on a free loopback port
 * until the current test finishes. A rejected handler answers 500.
 */
export async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => unknown,
): Promise<Fetcher> {
  const server = await new Promise<Server>((resolve) => {
    const next = createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((err: unknown) => {
        res.statusCode = 500;
        res.end(err instanceof Error ? err.message : "error");
      });
    });
    next.listen(0, "127.0.0.1", () => {
      resolve(next);
    });
  });
  onTestFinished(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err === undefined) {
            resolve();
            return;
          }
          reject(err);
        });
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new TypeError("expected tcp address");
  }
  const base = `http://127.0.0.1:${String(address.port)}`;
  return (path, init) => fetch(`${base}${path}`, init);
}
