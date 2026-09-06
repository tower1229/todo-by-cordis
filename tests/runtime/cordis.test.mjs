import assert from 'node:assert/strict';
import test from 'node:test';
import { Context, FiberState } from 'cordis';

test('missing dependency stays pending even after await()', async () => {
  const ctx = new Context();
  let calls = 0;
  const consumer = ctx.inject(['calculator'], () => { calls++; });
  await consumer.await();
  assert.equal(consumer.state, FiberState.PENDING);
  assert.equal(calls, 0);
  await consumer.dispose();
});

test('a dependent service follows provider removal and replacement', async () => {
  const ctx = new Context();
  const seen = [];
  let active = 0;
  const consumer = ctx.inject(['calculator'], (local) => {
    seen.push(local.calculator.add(2, 3));
    local.effect(() => { active++; return () => { active--; }; });
  });
  const provider = (offset) => ctx.plugin((local) => {
    local.provide('calculator', { add: (a, b) => a + b + offset });
  });
  const first = provider(0);
  await first.await();
  await consumer.await();
  assert.equal(consumer.state, FiberState.ACTIVE);
  assert.equal(active, 1);
  await first.dispose();
  await consumer.await();
  assert.equal(consumer.state, FiberState.PENDING);
  assert.equal(active, 0);
  const second = provider(10);
  await second.await();
  await consumer.await();
  assert.deepEqual(seen, [5, 15]);
  assert.equal(active, 1);
  await consumer.dispose();
  await second.dispose();
  assert.equal(active, 0);
});

test('async initialization is loading until its work completes', async () => {
  const ctx = new Context();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fiber = ctx.plugin(async () => { await gate; });
  assert.equal(fiber.state, FiberState.LOADING);
  release();
  await fiber.await();
  assert.equal(fiber.state, FiberState.ACTIVE);
  await fiber.dispose();
});

test('failed activation rejects readiness and clears registered effects', async () => {
  const ctx = new Context();
  let resources = 0;
  const fiber = ctx.plugin((local) => {
    local.effect(() => { resources++; return () => { resources--; }; });
    throw new Error('intentional activation failure');
  });
  await assert.rejects(fiber.await(), /intentional activation failure/);
  assert.equal(fiber.state, FiberState.FAILED);
  assert.equal(resources, 0);
  await fiber.dispose();
  // rc.9 removes the fiber but leaves the cached FAILED state unchanged.
  assert.equal(fiber.uid, null);
  assert.equal(fiber.state, FiberState.FAILED);
});

test('dispose waits for asynchronous cleanup', async () => {
  const ctx = new Context();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let cleaned = false;
  const fiber = ctx.plugin((local) => local.effect(() => async () => {
    await gate;
    cleaned = true;
  }));
  await fiber.await();
  const disposing = fiber.dispose();
  assert.equal(cleaned, false);
  release();
  await disposing;
  assert.equal(cleaned, true);
});

test('20 activation cycles leave no active resource or duplicate listener', async () => {
  const ctx = new Context();
  let resources = 0;
  let notifications = 0;
  for (let cycle = 0; cycle < 20; cycle++) {
    const fiber = ctx.plugin((local) => {
      local.effect(() => { resources++; return () => { resources--; }; });
      local.on('probe', () => { notifications++; });
    });
    await fiber.await();
    assert.equal(resources, 1);
    ctx.emit('probe');
    assert.equal(notifications, cycle + 1);
    await fiber.dispose();
    assert.equal(resources, 0);
    assert.deepEqual(fiber.getEffects(), []);
    ctx.emit('probe');
    assert.equal(notifications, cycle + 1);
  }
});

test('cleanup errors do not reject dispose, so completion alone is not proof', async () => {
  const ctx = new Context();
  let cleanupAttempted = false;
  const fiber = ctx.plugin((local) => {
    local.effect(() => () => {
      cleanupAttempted = true;
      throw new Error('intentional cleanup failure');
    });
  });
  await fiber.await();
  await assert.doesNotReject(fiber.dispose());
  assert.equal(cleanupAttempted, true);
  assert.equal(fiber.state, FiberState.DISPOSED);
});
