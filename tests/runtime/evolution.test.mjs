import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { openKernel } from '../../experiments/evolution/kernel.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cordis-m0-'));
  const filename = join(directory, 'probe.db');
  let kernel = await openKernel(filename);
  t.after(async () => {
    if (kernel) await kernel.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { filename, get kernel() { return kernel; }, async close() { await kernel.close(); kernel = null; }, async reopen() { kernel = await openKernel(filename); return kernel; } };
}

test('same action contract supports review, cancellation, rollback and restart', async (t) => {
  const f = await fixture(t);
  await f.kernel.create({ id: 'one', title: '保留同一条任务', fields: { manualEstimate: 15 } });
  assert.deepEqual((await f.kernel.describe('one')).actions, ['complete']);
  await f.kernel.publish('review');
  const input = await f.kernel.act('one', 'complete', {}, 1);
  assert.equal(input.kind, 'input-required');
  assert.equal(f.kernel.read('one').state, 'open');
  assert.equal(f.kernel.read('one').revision, 1);
  await f.kernel.act('one', 'complete', { review: '确实完成了' }, 1);
  await f.kernel.publish('default');
  assert.equal(f.kernel.read('one').state, 'done');
  assert.deepEqual(f.kernel.read('one').fields, { manualEstimate: 15, review: '确实完成了' });
  await f.close();
  await f.reopen();
  assert.equal(f.kernel.version(), 'default');
  assert.equal(f.kernel.read('one').fields.review, '确实完成了');
  await assert.rejects(f.kernel.act('one', 'reopen', {}, 1), /Revision conflict/);
});

test('second plugin activation failure preserves the complete old composition', async (t) => {
  const f = await fixture(t);
  await f.kernel.create({ id: 'one', title: '仍可操作' });
  await assert.rejects(f.kernel.publish('review', { failSecond: true }), /Second plugin activation failed/);
  assert.equal(f.kernel.version(), 'default');
  assert.equal((await f.kernel.act('one', 'complete', {}, 1)).kind, 'commit');
});

test('rollback requires total state mapping and retains manual fields', async (t) => {
  const f = await fixture(t);
  await f.kernel.publish('review');
  await f.kernel.create({ id: 'one', title: '复盘中', state: 'review', fields: { review: '草稿' } });
  await assert.rejects(f.kernel.publish('default'), /Missing mapping/);
  assert.equal(f.kernel.version(), 'review');
  await f.kernel.publish('default', { mapping: { review: 'open' } });
  assert.equal(f.kernel.read('one').state, 'open');
  assert.equal(f.kernel.read('one').fields.review, '草稿');
});

for (const stage of ['prepared', 'transaction', 'switched']) {
  test(`process crash at ${stage} recovers one consistent version and task mapping`, { timeout: 15000 }, async (t) => {
    const f = await fixture(t);
    await f.kernel.publish('review');
    await f.kernel.create({ id: 'one', title: '必须保留', state: 'review', fields: { manualEstimate: 15 } });
    await f.close();
    const child = fork(new URL('../../experiments/evolution/crash.mjs', import.meta.url), [f.filename, stage], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    const [code] = await once(child, 'exit');
    assert.equal(code, 17);
    await f.reopen();
    assert.equal(f.kernel.version(), stage === 'switched' ? 'default' : 'review');
    assert.equal(f.kernel.read('one').state, stage === 'switched' ? 'open' : 'review');
    assert.equal(f.kernel.read('one').fields.manualEstimate, 15);
  });
}
