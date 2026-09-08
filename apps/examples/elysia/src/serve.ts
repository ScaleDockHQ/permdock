import { app } from './app.ts';

const port = Number(process.env.PORT ?? 3459);

app.listen(port);
