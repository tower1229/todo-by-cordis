import { fork } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';

export async function connect(kind, timeoutMs = 5000, options = {}) {
  const url = options.url ?? new URL('./endpoint.mjs', import.meta.url);
  const endpoint = kind === 'worker'
    ? new Worker(url)
    : fork(url, options.args ?? [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let stderr = '';
  endpoint.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
  const pending = new Map();
  let serial = 0;
  let closed = false;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const fail = (error) => {
    readyReject(error);
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  };
  endpoint.on('error', fail);
  endpoint.on('exit', (code) => { closed = true; fail(new Error(`Endpoint exited (${code}): ${stderr}`)); });
  endpoint.on('message', (message) => {
    if (message.ready) { readyResolve(); return; }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    request.resolve(message);
  });
  async function close() {
    if (closed) return;
    if (kind === 'worker') { await endpoint.terminate(); return; }
    const exited = once(endpoint, 'exit');
    endpoint.kill('SIGKILL');
    await exited;
  }
  const startupTimer = setTimeout(() => readyReject(new Error('Endpoint startup timed out')), timeoutMs);
  try { await ready; } catch (error) { await close(); throw error; }
  finally { clearTimeout(startupTimer); }
  return {
    request(input, type = 'calculate') {
      const id = ++serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Request timed out'));
          void close().catch(fail);
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        const message = { id, type, input };
        if (kind === 'worker') endpoint.postMessage(message);
        else endpoint.send(message, (error) => { if (error) fail(error); });
      });
    },
    close,
  };
}
