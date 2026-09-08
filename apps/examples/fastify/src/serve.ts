import { app } from './app.ts';

const port = Number(process.env.PORT ?? 3458);
const host = '127.0.0.1';

await app.listen({ port, host });
