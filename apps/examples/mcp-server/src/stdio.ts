import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { memberUser } from './policy.ts';
import { createServer } from './server.ts';

// A stdio server runs as the local user: there is no token, so scopes are
// not checked and the subject is the account that launched the process.
const server = createServer({ local: memberUser });
await server.connect(new StdioServerTransport());
