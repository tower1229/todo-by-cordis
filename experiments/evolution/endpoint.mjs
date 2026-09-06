import { Context, FiberState } from 'cordis';
import { workflows } from './workflows.mjs';

process.on('disconnect', () => process.exit(0));

const ctx = new Context();
const version = process.argv[2];
const workflow = workflows[version];
if (!workflow) throw new Error(`Unknown workflow: ${version}`);
const provider = ctx.plugin((local) => local.provide('workflow', workflow));
let execute;
const consumer = ctx.inject(['workflow'], (local) => {
  execute = ({ task, action, input }) => {
    if (!action) return { actions: local.workflow.actions(task), states: local.workflow.states };
    if (!local.workflow.actions(task).includes(action)) throw new Error('Action not available');
    return local.workflow.decide(task, action, input);
  };
});
await provider.await();
await consumer.await();
// The second required plugin fails after the workflow has initialized.
if (process.argv[3] === 'fail-second') {
  const failed = ctx.plugin(() => { throw new Error('Second plugin activation failed'); });
  await failed.await();
}
if (provider.state !== FiberState.ACTIVE || consumer.state !== FiberState.ACTIVE) throw new Error('Composition not ready');
process.on('message', ({ id, input }) => {
  try { process.send({ id, value: execute(input) }); }
  catch (error) { process.send({ id, error: error.message }); }
});
process.send({ ready: true });
