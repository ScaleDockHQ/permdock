import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { HttpMounted } from "permdock/testing";

/** Replays a runner request against a real origin, with the body as bytes. */
export async function forward(
  origin: string,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const bodyless = request.method === "GET" || request.method === "HEAD";
  return fetch(new URL(`${url.pathname}${url.search}`, origin), {
    method: request.method,
    headers: request.headers,
    ...(bodyless ? {} : { body: await request.arrayBuffer() }),
    redirect: "manual",
  });
}

/** Listens on an ephemeral port and forwards the runner's requests over real HTTP. */
export async function listen(server: Server): Promise<HttpMounted> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  // SAFETY: the server listens on a TCP port, so address() is AddressInfo
  const { port } = server.address() as AddressInfo;
  return {
    fetch: (request) => forward(`http://127.0.0.1:${port}`, request),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
        server.closeAllConnections();
      }),
  };
}
