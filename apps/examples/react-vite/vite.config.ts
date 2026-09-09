import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

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
  if (req.url === '/health') {
    res.statusCode = 200;
    res.end('ok');
    return;
  }
  next();
}

function healthPlugin(): Plugin {
  return {
    name: 'health',
    configureServer(server) {
      server.middlewares.use(healthHandle);
    },
    configurePreviewServer(server) {
      server.middlewares.use(healthHandle);
    },
  };
}

export default defineConfig({
  plugins: [react(), healthPlugin()],
  server: {
    host: '127.0.0.1',
    port: 3480,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 3480,
    strictPort: true,
  },
});
