import { serve } from "h3";

import { app } from "./app.ts";

serve(app, {
  port: Number(process.env["PORT"] ?? 3457),
  hostname: "127.0.0.1",
});
