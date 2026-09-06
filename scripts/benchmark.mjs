import { Workspace } from "../dist/server/workspace.js";
import { createApp } from "../dist/server/app.js";
import { serve } from "@hono/node-server";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, cpus, platform, release } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const directory = await mkdtemp(join(tmpdir(), "cordis-benchmark-"));
const workspace = await Workspace.open(join(directory, "bench.db"));
const server = serve({
  fetch: createApp(workspace).fetch,
  hostname: "127.0.0.1",
  port: 0,
});
await new Promise((resolve) =>
  server.listening ? resolve() : server.once("listening", resolve),
);
const base = `http://127.0.0.1:${server.address().port}/api`;
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    p50Ms: sorted[Math.ceil(values.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(values.length * 0.95) - 1],
    maxMs: sorted.at(-1),
  };
};
const post = async (path, body) => {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message);
  return result;
};
try {
  let task;
  for (let i = 0; i < 1000; i++)
    ({ task } = await workspace.command({
      type: "create",
      title: `任务 ${i}`,
      description: "性能样例",
      compositionRevision: 1,
      operationId: randomUUID(),
    }));
  const query = [],
    write = [];
  for (let i = 0; i < 1200; i++) {
    let start = performance.now();
    const response = await fetch(base + "/tasks?category=all");
    await response.json();
    if (i >= 200) query.push(performance.now() - start);
    start = performance.now();
    ({ task } = await post("/commands", {
      type: "edit",
      taskId: task.id,
      expectedRevision: task.revision,
      title: `修改 ${i}`,
      description: "性能样例",
      compositionRevision: 1,
      operationId: randomUUID(),
    }));
    if (i >= 200) write.push(performance.now() - start);
  }
  for (let i = 0; i < 20; i++)
    await post("/releases", {
      workflowId: i % 2 ? "default" : "review",
      compositionRevision: i + 1,
      operationId: randomUUID(),
    });
  const history = workspace.composition().history;
  const report = {
    recordedAt: new Date().toISOString(),
    node: process.version,
    platform: `${platform()} ${release()}`,
    cpu: cpus()[0].model,
    method:
      "Production build, 1000 persisted tasks, HTTP loopback; 200 warmup + 1000 sequential measured reads and edits; 20 switches; no model.",
    query: stats(query),
    write: stats(write),
    switchPause: stats(history.map((h) => h.pausedMs)),
    preparation: stats(history.map((h) => h.preparationMs)),
  };
  await writeFile(
    "docs/reports/m1-benchmark.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
  if (
    report.query.p95Ms > 50 ||
    report.write.p95Ms > 50 ||
    report.switchPause.maxMs > 300
  )
    process.exitCode = 1;
} finally {
  await new Promise((resolve) => server.close(resolve));
  await workspace.close();
  await rm(directory, { recursive: true, force: true });
}
