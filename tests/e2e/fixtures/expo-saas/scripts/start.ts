import type { createRequestHandler as CreateRequestHandler } from 'expo-server/adapter/http';

import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// expo-server 57's ESM build has extensionless relative imports that Node cannot resolve.
// SAFETY: the CommonJS build of expo-server/adapter/http exports createRequestHandler
const { createRequestHandler } = createRequire(import.meta.url)(
  'expo-server/adapter/http',
) as {
  createRequestHandler: typeof CreateRequestHandler;
};

const cwd = join(dirname(fileURLToPath(import.meta.url)), '..');
const client = join(cwd, 'dist/client');
// `expo export` writes CommonJS API routes; the fixture package itself is ESM.
writeFileSync(
  join(cwd, 'dist/server/package.json'),
  '{ "type": "commonjs" }\n',
);

const handle = createRequestHandler({ build: join(cwd, 'dist/server') });

const TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

/** Static assets from `dist/client`, then Expo Router (pages and `+api` routes). */
createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const file = normalize(join(client, decodeURIComponent(url.pathname)));
  if (
    url.pathname !== '/' &&
    file.startsWith(client) &&
    existsSync(file) &&
    statSync(file).isFile() &&
    extname(file) !== '.html'
  ) {
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    });
    createReadStream(file).pipe(response);
    return;
  }
  void handle(request, response, (error?: unknown) => {
    if (error !== undefined) {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : 'request failed'}\n`,
      );
    }
    response.writeHead(error === undefined ? 404 : 500).end();
  });
}).listen(
  Number(process.env['PORT'] ?? 3504),
  process.env['HOST'] ?? '127.0.0.1',
);
