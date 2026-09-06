import { openKernel } from './kernel.mjs';
const kernel = await openKernel(process.argv[2]);
await kernel.publish('default', { crashAt: process.argv[3], mapping: { review: 'open' } });
await kernel.close();
