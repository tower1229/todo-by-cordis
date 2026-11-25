import assert from "node:assert/strict";
import type { APIRequestContext } from "playwright";
import type { EvolutionRunView } from "../src/evolution/loop.js";
import type { HostAppHandle } from "../src/main.js";

const TASKS_ROUTE = "/api/app/todo-core/tasks";
const TAGS_ROUTE = "/api/app/todo-tags/tags";
const HISTORICAL_LABEL = "URGENT";
const NEW_LABEL = "backend";

interface Tag {
  readonly id: string;
  readonly label: string;
}

interface TagUpgradeFixture {
  readonly taskId: string;
  readonly historicalTag: Tag;
}

async function readTags(
  request: APIRequestContext,
  url: string,
  taskId: string,
): Promise<Tag[]> {
  const response = await request.get(`${url}${TAGS_ROUTE}`, {
    params: { taskId },
  });
  assert.equal(response.status(), 200, "读取任务标签应返回 HTTP 200");
  const { tags } = (await response.json()) as { tags: Tag[] };
  assert.ok(Array.isArray(tags), "标签接口应返回 tags 数组");
  return tags
    .map(({ id, label }) => {
      assert.ok(typeof id === "string" && id.length > 0, "标签应有稳定的 id");
      assert.equal(typeof label, "string", "标签应有字符串 label");
      return { id, label };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function saveTag(
  request: APIRequestContext,
  url: string,
  taskId: string,
  label: string,
  duplicate = false,
): Promise<void> {
  const response = await request.post(`${url}${TAGS_ROUTE}`, {
    data: { taskId, label },
  });
  assert.ok(
    response.ok() || (duplicate && response.status() === 409),
    `保存标签 ${label} 返回了 HTTP ${response.status()}`,
  );
}

export async function seedTodoTagUpgrade(
  request: APIRequestContext,
  url: string,
): Promise<TagUpgradeFixture> {
  const response = await request.post(`${url}${TASKS_ROUTE}`, {
    data: { title: "Todo 标签升级独立验收" },
  });
  assert.equal(response.status(), 201, "应在升级前创建验收任务");
  const { task } = (await response.json()) as { task: { id: string } };
  assert.ok(
    typeof task?.id === "string" && task.id.length > 0,
    "应返回任务 id",
  );
  await saveTag(request, url, task.id, HISTORICAL_LABEL);
  const tags = await readTags(request, url, task.id);
  assert.deepEqual(
    tags.map((tag) => tag.label),
    [HISTORICAL_LABEL],
    "旧版应原样保存大写标签",
  );
  return { taskId: task.id, historicalTag: tags[0]! };
}

async function checkUpgrade(
  request: APIRequestContext,
  url: string,
  { taskId, historicalTag }: TagUpgradeFixture,
): Promise<Tag> {
  assert.deepEqual(
    await readTags(request, url, taskId),
    [historicalTag],
    "升级应保留历史大写标签及其 id",
  );

  await saveTag(request, url, taskId, "Backend");
  const tags = await readTags(request, url, taskId);
  const newTag = tags.find((tag) => tag.id !== historicalTag.id);
  assert.equal(newTag?.label, NEW_LABEL, "新保存的标签应转换为小写");
  assert.deepEqual(
    tags.filter((tag) => tag.id === historicalTag.id),
    [historicalTag],
    "写入应保留历史标签",
  );
  assert.equal(tags.length, 2, "第一次保存应只添加一个标签");

  await saveTag(request, url, taskId, "BACKEND", true);
  assert.deepEqual(
    await readTags(request, url, taskId),
    tags,
    "同一任务的新标签应按大小写去重，并保留已有标签 id",
  );
  return newTag!;
}

export async function acceptTodoTagUpgrade(
  app: HostAppHandle,
  request: APIRequestContext,
  run: EvolutionRunView,
  fixture: TagUpgradeFixture,
) {
  const preview = await app.evolution.restorePreview(run.runId);
  await checkUpgrade(request, preview.previewUrl, fixture);
  assert.deepEqual(
    await readTags(request, app.url, fixture.taskId),
    [fixture.historicalTag],
    "候选预览中的写入应与验收实例的正式数据隔离",
  );

  const { composition: applied } = await app.evolution.applyRun(run.runId);
  const newTag = await checkUpgrade(request, app.url, fixture);
  const { composition: rolledBack } = await app.release.rollback(
    preview.baseCompositionId,
    applied.compositionId,
  );
  const restoredTags = await readTags(request, app.url, fixture.taskId);
  assert.deepEqual(
    restoredTags,
    [fixture.historicalTag, newTag].sort((a, b) => a.id.localeCompare(b.id)),
    "撤回后旧版应能读取原大写标签和新版写入的小写标签",
  );

  // Resume the accepted composition for the remaining steps in the scenario.
  const { composition: resumed } = await app.release.rollback(
    applied.compositionId,
    rolledBack.compositionId,
  );
  return {
    status: "passed" as const,
    candidateId: preview.candidateId,
    appliedCompositionId: applied.compositionId,
    rollbackCompositionId: rolledBack.compositionId,
    resumedCompositionId: resumed.compositionId,
  };
}
