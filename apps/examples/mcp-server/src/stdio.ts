import { tools } from './server.ts';

const names = [...tools.keys()].toSorted().join(',');
process.stderr.write(`mcp-server ready tools=${names}\n`);
process.stdin.resume();
