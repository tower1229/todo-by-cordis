import { Context } from 'cordis';

export async function createService() {
  const ctx = new Context();
  const provider = ctx.plugin((local) => {
    local.provide('calculator', { add: (a, b) => a + b });
  });
  let calculate;
  const consumer = ctx.inject(['calculator'], (local) => {
    calculate = (input) => local.calculator.add(input.a, input.b);
  });
  await provider.await();
  await consumer.await();
  return { calculate, async dispose() { await consumer.dispose(); await provider.dispose(); } };
}
