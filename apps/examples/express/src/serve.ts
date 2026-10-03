import { app } from "./app.ts";

const port = Number(process.env["PORT"] ?? 3457);
const host = "127.0.0.1";

app.listen(port, host);
