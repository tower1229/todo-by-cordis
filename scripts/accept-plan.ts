// Run only after explicit authorization to send project sources to Gemini.
// Synthetic workspace; observes planning only and never generates candidates.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Workspace } from "../src/server/workspace.js";
import { Evolution } from "../src/evolution/evolution.js";
import { Gemini } from "../src/evolution/gemini.js";
import { EvolutionDomain } from "../src/server/evolution-domain.js";
import { createApp } from "../src/server/app.js";
import assert from "node:assert/strict";
if (existsSync(".env")) process.loadEnvFile(".env");
if (!process.env.GEMINI_API_KEY)
  throw Error("GEMINI_API_KEY is not configured");
const directory =
  process.env.ACCEPTANCE_PATH ?? `.runtime/planning-${Date.now()}`;
mkdirSync(directory, { recursive: true });
const w = await Workspace.open(`${directory}/workspace.db`);
const e = new Evolution(
  w.db,
  new Gemini(process.env.GEMINI_API_KEY),
  new EvolutionDomain(w),
);
const app = createApp(w, e);
const evidence: unknown[] = [];
try {
  const before = w.composition();
  for (const text of [
    "帮我新增一个买菜任务。",
    "完成任务前必须填写复盘，去除空白后 1 到 5000 字，已有数据保留，其余行为保持。",
    "希望应用支持离线到期提醒，包括必要业务提供者和界面，在关闭页面后仍能提醒；不退化为文本记录。",
  ]) {
    const sent = await app.request("/api/assistant/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "request",
        operationId: randomUUID(),
        text,
      }),
    });
    assert.equal(sent.status, 200);
    let snapshot;
    for (;;) {
      snapshot = await (await app.request("/api/assistant")).json();
      if (snapshot.run.status !== "planning") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    evidence.push(snapshot);
    console.log(
      JSON.stringify({
        request: text,
        status: snapshot.run.status,
        message: snapshot.run.message,
        question: snapshot.run.question,
      }),
    );
    assert.notEqual(snapshot.run.status, "failed");
    if (text.startsWith("帮我")) assert.equal(snapshot.run.status, "dismissed");
    else if (text.startsWith("完成任务"))
      assert.equal(snapshot.run.status, "ready");
    else assert.ok(["awaiting-input", "blocked"].includes(snapshot.run.status));
    assert.deepEqual(w.composition(), before);
    assert.equal(w.query().total, 0);
    assert.equal(w.release.all().length, 2);
    await app.request("/api/assistant/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "cancel",
        operationId: randomUUID(),
        runId: snapshot.run.id,
      }),
    });
  }
  console.log(`PASS ${directory}`);
} finally {
  evidence.push({
    calls: w.db
      .prepare("SELECT runId,body FROM evolution_calls")
      .all()
      .map((r) => ({ runId: r.runId, ...JSON.parse(String(r.body)) })),
  });
  writeFileSync(
    `${directory}/evidence.json`,
    JSON.stringify(evidence, null, 2),
  );
  await e.close();
  await w.close();
}
