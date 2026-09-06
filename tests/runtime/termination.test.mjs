import assert from 'node:assert/strict';
import test from 'node:test';
import { connect } from '../../experiments/runtime/transport.mjs';

for (const kind of ['worker', 'child']) {
  test(`${kind}: infinite-loop endpoint can be terminated and replaced`, { timeout: 15000 }, async () => {
    const endpoint = await connect(kind);
    try {
      assert.equal((await endpoint.request({ a: 2, b: 3 })).value, 5);
      assert.equal((await endpoint.request(null, 'loop')).entered, true);
    } finally { await endpoint.close(); }
    const replacement = await connect(kind);
    try { assert.equal((await replacement.request({ a: 4, b: 5 })).value, 9); }
    finally { await replacement.close(); }
  });
}
