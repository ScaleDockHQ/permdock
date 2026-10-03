import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

type HealthRequest = { readonly url?: string };
type HealthResponse = {
  statusCode: number;
  end: (body: string) => void;
};

function healthHandle(
  req: HealthRequest,
  res: HealthResponse,
  next: () => void,
): void {
  if (req.url === "/health") {
    res.statusCode = 200;
    res.end("ok");
    return;
  }
  next();
}

function healthPlugin(): Plugin {
  return {
    name: "health",
    configureServer(server) {
      server.middlewares.use(healthHandle);
    },
    configurePreviewServer(server) {
      server.middlewares.use(healthHandle);
    },
  };
}

export default defineConfig({
  plugins: [solid(), healthPlugin()],
  server: {
    host: "127.0.0.1",
    port: 3483,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 3483,
    strictPort: true,
  },
});
