// Measures one Node.js process (one CPU core) with the LLM replaced by a mock
// that waits MOCK_LATENCY_MS. That isolates what *our* code costs, which is
// what the fleet-size math in the report needs.
//
//   npm run bench
import autocannon from 'autocannon';
import { execSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 8799;
const URL = `http://127.0.0.1:${PORT}`;
const DURATION = Number(process.env.BENCH_SECONDS || 15);

const server = spawn(process.execPath, ['src/node.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    MOCK_LLM: '1',
    MOCK_LATENCY_MS: '350',
    RATE_DEVICE_PER_MIN: '100000000',
    RATE_IP_PER_MIN: '100000000',
    CACHE_MAX_ENTRIES: '200000',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
await sleep(800);

const rssMb = () => Math.round(Number(execSync(`ps -o rss= -p ${server.pid}`).toString().trim()) / 1024);
const headers = { 'content-type': 'application/json', 'x-device-id': 'bench-device-0001' };
let n = 0;

function run(title, opts) {
  return new Promise((resolve, reject) => {
    autocannon({ url: `${URL}/v1/ask`, method: 'POST', headers, duration: DURATION, ...opts }, (err, r) => {
      if (err) return reject(err);
      resolve({
        scenario: title,
        connections: opts.connections,
        rps: Math.round(r.requests.average),
        p50ms: r.latency.p50,
        p99ms: r.latency.p99,
        non2xx: r.non2xx,
        errors: r.errors,
        rssMb: rssMb(),
      });
    });
  });
}

const results = [];

// 1. Cache hits: the path a popular question takes. Pure framework + hash + LRU cost.
await fetch(`${URL}/v1/ask`, { method: 'POST', headers, body: JSON.stringify({ query: 'what is upi' }) });
results.push(await run('cache hit', { connections: 100, body: JSON.stringify({ query: 'what is upi' }) }));

// 2. Cache misses with a 350 ms upstream: every request is a unique question held
//    open while the "LLM" thinks. Shows how many in-flight calls one process carries.
results.push(
  await run('cache miss, 350 ms LLM', {
    connections: 2000,
    requests: [{ setupRequest: (req) => ({ ...req, body: JSON.stringify({ query: `question number ${n++}` }) }) }],
  }),
);

const metrics = await (await fetch(`${URL}/metrics`)).json();
server.kill('SIGTERM');

console.table(results);
console.log(JSON.stringify({ node: process.version, cpu: execSync('sysctl -n machdep.cpu.brand_string 2>/dev/null || nproc').toString().trim(), results, metrics }, null, 2));
