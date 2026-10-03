import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const cwd = join(dirname(fileURLToPath(import.meta.url)), "..");
const client = join(cwd, "dist/client");
// SAFETY: the TanStack Start server build default-exports a fetch handler
const entry = (await import(
  pathToFileURL(join(cwd, "dist/server/server.js")).href
)) as {
  readonly default: { fetch(request: Request): Promise<Response> | Response };
};

const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** A static-file-then-fetch Node server for the built Start app. */
createServer((incoming, outgoing) => {
  const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
  const file = normalize(join(client, decodeURIComponent(url.pathname)));
  if (file.startsWith(client) && existsSync(file) && statSync(file).isFile()) {
    outgoing.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    });
    createReadStream(file).pipe(outgoing);
    return;
  }
  const method = incoming.method ?? "GET";
  const request = new Request(
    new URL(
      url.pathname + url.search,
      `http://${incoming.headers.host ?? "127.0.0.1"}`,
    ),
    {
      method,
      // SAFETY: Node joins repeated request headers into strings, except set-cookie, absent on requests
      headers: incoming.headers as Record<string, string>,
      // SAFETY: Readable.toWeb returns a web ReadableStream; Node types it as its own stream class
      ...(method === "GET" || method === "HEAD"
        ? {}
        : { body: Readable.toWeb(incoming) as ReadableStream, duplex: "half" }),
    },
  );
  Promise.resolve(entry.default.fetch(request))
    .then(async (response) => {
      const headers: Record<string, string | string[]> = {};
      for (const [key, value] of response.headers) {
        headers[key] = value;
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) {
        headers["set-cookie"] = cookies;
      }
      outgoing.writeHead(response.status, headers);
      if (response.body === null) {
        outgoing.end();
        return;
      }
      for await (const chunk of response.body) {
        outgoing.write(chunk);
      }
      outgoing.end();
    })
    .catch((error: unknown) => {
      outgoing.writeHead(500).end(String(error));
    });
}).listen(Number(process.env.PORT ?? 3502), process.env.HOST ?? "127.0.0.1");
