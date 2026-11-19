// Cloudflare Workers entry: same app, config read from Worker bindings/secrets.
// Free plan: 100,000 requests/day, no cold-start sleep, global edge.
import { createApp } from './app.js';
import { loadConfig } from './config.js';

export default createApp((c) => loadConfig(c.env));
