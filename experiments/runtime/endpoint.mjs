import { parentPort } from 'node:worker_threads';
import { createService } from './service.mjs';

const channel = parentPort ?? process;
const send = (message) => parentPort ? parentPort.postMessage(message) : process.send(message);
const service = await createService();
channel.on('message', (message) => {
  if (message.type === 'loop') {
    send({ id: message.id, entered: true });
    while (true) { /* Deliberate fault: the supervisor must terminate this endpoint. */ }
  }
  send({ id: message.id, value: service.calculate(message.input) });
});
send({ ready: true });
