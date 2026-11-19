// Node.js entry: containers, Render, Koyeb, a laptop. One process per container;
// scale out with more containers rather than node:cluster inside one.
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

try {
  process.loadEnvFile();
} catch {
  /* no .env file: rely on real env vars */
}

const config = loadConfig(process.env);
const app = createApp(() => config);
const port = Number(process.env.PORT || 8787);

const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
  const names = config.providers.map((p) => `${p.name}:${p.model}`).join(' -> ');
  console.log(`vaani api on :${port}  providers ${names}`);
});

// Keep-alive longer than typical load balancer idle timeouts (60s) to avoid 502s on reused sockets.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
