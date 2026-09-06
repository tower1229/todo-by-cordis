import assert from 'node:assert/strict';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createService } from './service.mjs';
import { connect } from './transport.mjs';

const count = 3000;
const warmup = 300;
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  return { samples: values.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99) };
};
const results = {};
for (const kind of ['direct', 'worker', 'child']) {
  const startup = [];
  const latency = [];
  for (let round = 0; round < 3; round++) {
    const begin = performance.now();
    const service = kind === 'direct' ? await createService() : await connect(kind);
    startup.push(performance.now() - begin);
    const calculate = kind === 'direct'
      ? async (input) => service.calculate(input)
      : async (input) => (await service.request(input)).value;
    try {
      for (let i = 0; i < warmup + count; i++) {
        const start = performance.now();
        const actual = await calculate({ a: i, b: 3 });
        const elapsed = performance.now() - start;
        assert.equal(actual, i + 3);
        if (i >= warmup) latency.push(elapsed);
      }
    } finally { await (kind === 'direct' ? service.dispose() : service.close()); }
  }
  results[kind] = { startup: stats(startup), roundTrip: stats(latency) };
}
console.log(JSON.stringify({
  recordedAt: new Date().toISOString(), node: process.version,
  platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0].model,
  method: '3 sequential rounds per transport; 300 warmup and 3000 measured calls per round; tiny JSON input; Cordis provider + consumer; excludes HTTP/DB/model/UI',
  results,
}, null, 2));
