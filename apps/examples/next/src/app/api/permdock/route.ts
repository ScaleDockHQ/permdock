import { permdockHandler } from '../../../permdock/server.ts';

// Decision endpoint for grants a snapshot cannot answer on the client.
export const { POST, GET } = permdockHandler();
