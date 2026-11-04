import type { ReactElement } from "react";

import { prerenderToNodeStream } from "react-dom/static";

/**
 * The markup `renderToStaticMarkup` would give, once every Suspense boundary
 * has settled: the provider loads the evaluator through `use()`, which the
 * synchronous renderers cannot wait for.
 */
export async function renderSettled(element: ReactElement): Promise<string> {
  const { prelude } = await prerenderToNodeStream(element);
  const chunks: Buffer[] = [];
  for await (const chunk of prelude) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .replaceAll(/<!--(?:\$|\/\$|\$\?|\$!| )?-->/gu, "");
}
