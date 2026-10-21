import { resolveVersionMembers } from "../release/composition.js";
import type {
  Browser,
  BrowserContext,
  Page,
  Response as BrowserResponse,
} from "playwright";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { ServerType } from "@hono/node-server";
import type { Version } from "../release/types.js";
import type { Task } from "../shared/contracts.js";
import type { Requirement } from "../shared/assistant.js";
import type {
  BrowserCase,
  BrowserEvidence,
  BrowserStep,
  BrowserCaseResult,
} from "../shared/browser-cases.js";
import { hash } from "../release/storage.js";
import { Workspace } from "./workspace.js";
import { createApp } from "./app.js";
import { importCompositionVersions } from "./workspace-acceptance.js";
import { workflowProtocolProgram } from "../release/workflow-protocol.js";
import type { MemberAcceptanceCase } from "../shared/acceptance-cases.js";
import { operationPreparation } from "../evolution/obligation-derivation.js";
import { createControllableClock, type ControllableClock } from "./host/clock.js";

export class BrowserEnvironmentError extends Error {
  constructor(
    message: string,
    public evidence?: BrowserEvidence,
    public versionId?: string,
  ) {
    super(message);
  }
}
/** A frozen public-page step cannot execute an authoritative internal schedule channel. */
export class BrowserDefinitionError extends BrowserEnvironmentError {
  override name = "BrowserDefinitionError";
}
export class BrowserAssertionError extends Error {
  constructor(
    message: string,
    public evidence: BrowserEvidence,
  ) {
    super(message);
  }
}
export class BrowserCancelledError extends Error {
  constructor(
    reason: unknown,
    public evidence: BrowserEvidence,
  ) {
    super(reason instanceof Error ? reason.message : String(reason));
  }
}
export function candidateProgramHash(workspace: Workspace, version: Version) {
  return hash({
    code: version.code,
    bundle: version.bundle,
    members: resolveVersionMembers(version).map((m) => {
      const v =
        m.versionId && m.versionId !== version.id
          ? workspace.release.get(m.versionId)
          : version;
      return {
        pluginId: m.pluginId,
        role: m.role,
        enabled: m.enabled,
        code: v.code,
        bundle: v.bundle,
        ...(v.workflowProtocol ? {workflowProtocol:workflowProtocolProgram(v.workflowProtocol)} : {}),
      };
    }),
  });
}
export const browserViewports = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? files(join(root, entry.name))
        : [join(root, entry.name)],
    )
    .sort();
}
function browserEngine(): typeof import("playwright") | undefined {
  try {
    return createRequire(import.meta.url)(
      "playwright",
    ) as typeof import("playwright");
  } catch {
    return undefined;
  }
}
export function browserEnvironment(
  root = resolve("dist/web"),
  executable = browserEngine()?.chromium.executablePath() ?? "",
) {
  const missing: string[] = [];
  if (!browserEngine()) missing.push("Playwright 运行依赖不可用");
  if (!existsSync(executable))
    missing.push("Chromium 未安装（运行中不会自动下载安装）");
  let frontendHash = "";
  if (!existsSync(join(root, "index.html")))
    missing.push("前端构建不存在，请先构建");
  else
    frontendHash = hash(
      files(root).map((path) => ({
        path: relative(root, path),
        hash: hash(readFileSync(path).toString("base64")),
      })),
    );
  return {
    root,
    executable,
    frontendHash,
    missing,
    checkerHash: hash({
      version: "browser/1",
      source: readFileSync(resolve("src/server/browser-acceptance.ts"), "utf8"),
      preparation: readFileSync(resolve("src/evolution/obligation-derivation.ts"), "utf8"),
      clock: readFileSync(resolve("src/server/host/clock.ts"), "utf8"),
      contract: readFileSync(resolve("src/shared/browser-cases.ts"), "utf8"),
      caseSchema: readFileSync(
        resolve("src/shared/browser-contract.ts"),
        "utf8",
      ),
      obligations: readFileSync(
        resolve("src/shared/acceptance-obligations.ts"),
        "utf8",
      ),
      playwright: "1.63.0",
      presentation: readFileSync(
        resolve("src/shared/field-presentation.ts"),
        "utf8",
      ),
      viewports: browserViewports,
    }),
  };
}
const attr = (name: string, value: string) =>
  `[data-${name}=${JSON.stringify(value)}]`;

/** One action transaction, including an already-open form after a rejection. */
async function browserAction(
  page: Page,
  step: Extract<BrowserStep, { kind: "action" }>,
  owner: string,
  taskId: string,
  open: () => Promise<void>,
  command: (action: () => Promise<unknown>) => Promise<BrowserResponse>,
) {
  const form = page.locator("[data-action-form]");
  let awaitingInput = await form.isVisible();
  if (
    awaitingInput &&
    (await form.getAttribute("data-action-form")) !== step.action
  ) {
    await form.getByRole("button", { name: "取消", exact: true }).click();
    await open();
    awaitingInput = false;
  }
  if (!awaitingInput) {
    const editor = page.locator("[data-task-editor]");
    if (!(await editor.isVisible())) await open();
    const contributionAction = editor
      .locator(attr("provider", owner))
      .locator(attr("action-id", step.action));
    let response: BrowserResponse;
    if (await contributionAction.count())
      response = await command(() => contributionAction.click());
    else {
      await page
        .getByRole("button", { name: "关闭任务详情", exact: true })
        .click();
      response = await command(() =>
        page
          .locator(attr("task-id", taskId))
          .locator(attr("action-id", step.action))
          .click(),
      );
    }
    const body = (await response.json()) as { decision?: { kind?: string } };
    if (response.ok() && body.decision?.kind === "commit") {
      if (Object.keys(step.input ?? {}).length)
        throw new Error("动作直接提交而未请求表单，冻结的非空输入未被使用");
      await open();
      return;
    }
    if (!response.ok() || body.decision?.kind !== "input-required") return;
    await form.waitFor({ state: "visible" });
  }
  if (step.input === undefined) return;
  // Each data step describes the entire input. Failed drafts must not leak into
  // a subsequent retry or silently supply fields omitted by the frozen case.
  const fields = await form.locator("[data-input-field]").all();
  const keys = await Promise.all(
    fields.map((field) => field.getAttribute("data-input-field")),
  );
  if (keys.some((key) => !key))
    throw new BrowserEnvironmentError("browser/1 输入字段缺少宿主 DOM 标识");
  if (Object.keys(step.input).some((key) => !keys.includes(key)))
    throw new Error("冻结输入字段在实际动作表单中不存在");
  for (const [index, field] of fields.entries())
    await field.fill(step.input[keys[index]!] ?? "");
  if (await form.locator(":invalid").count())
    throw new Error("动作表单被宿主原生输入校验阻止，未发送提交请求");
  const response = await command(() =>
    form.locator('button[type="submit"]').click(),
  );
  const body = (await response.json()) as { decision?: { kind?: string } };
  if (response.ok() && body.decision?.kind === "commit") {
    await form.waitFor({ state: "hidden" });
    await open();
  }
}

/** Uses only host-owned selectors and exact semantic IDs validated during planning. */
export async function verifyBrowser(
  formal: Workspace,
  candidate: Version,
  base: Version,
  cases: BrowserCase[],
  requirements: Requirement[],
  definitionHash: string,
  signal: AbortSignal,
  memberCases: MemberAcceptanceCase[] = [],
): Promise<BrowserEvidence> {
  const env = browserEnvironment();
  if (env.missing.length)
    throw new BrowserEnvironmentError(
      `browser/1 环境不可用：${env.missing.join("；")}`,
    );
  const directory = resolve(
    ".runtime/browser-acceptance",
    `${candidate.id}-${randomUUID()}`,
  );
  await mkdir(directory, { recursive: true });
  const fixtures = {
    existing: "基础版本已有任务",
    new: "候选应用后新任务",
    title: "浏览器合成任务",
    description: "隔离验收备注",
    viewports: browserViewports,
    preparations: cases
      .filter((c) => c.prepare)
      .map((c) => ({ caseId: c.id, prepare: c.prepare })),
  };
  const evidence: BrowserEvidence = {
    checker: "browser/1",
    checkerHash: env.checkerHash,
    candidateVersion: candidate.id,
    baseVersion: base.id,
    candidateProgramHash: candidateProgramHash(formal, candidate),
    definitionHash,
    frontendHash: env.frontendHash,
    fixtureHash: hash(fixtures),
    directory,
    results: [],
    preparations: [],
  };
  const fixtureTasks: {
    viewport: { width: number; height: number };
    caseId: string;
    task: Task;
    initial: { title: string; description: string };
  }[] = [];
  await writeFile(
    join(directory, "fixtures.json"),
    JSON.stringify({ definition: fixtures, tasks: fixtureTasks }, null, 2),
  );
  let browser: Browser | undefined;
  let isolated: Workspace | undefined;
  let server: ServerType | undefined;
  let context: BrowserContext | undefined;
  const closeServer = async () => {
    if (server) {
      const current = server;
      server = undefined;
      if ("closeAllConnections" in current) current.closeAllConnections();
      await new Promise<void>((done) => current.close(() => done()));
    }
  };
  const abort = () => {
    void context?.close().catch(() => {});
    void browser?.close().catch(() => {});
    if (server && "closeAllConnections" in server) server.closeAllConnections();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    try {
      const engine = browserEngine();
      if (!engine)
        throw new BrowserEnvironmentError("Playwright 运行依赖不可用");
      browser = await engine.chromium.launch({ headless: true });
      evidence.browserVersion = browser.version();
    } catch (error) {
      throw new BrowserEnvironmentError(
        `browser/1 Chromium 启动失败：${error instanceof Error ? error.message : error}`,
      );
    }
    for (const [viewportIndex, viewport] of browserViewports.entries()) {
      signal.throwIfAborted();
      const dbPath = join(directory, `workspace-${viewportIndex}.db`);
      let acceptanceClock: ControllableClock | undefined;
      isolated = await Workspace.open(dbPath, { acceptanceProbe: true });
      importCompositionVersions(formal, isolated, base);
      importCompositionVersions(formal, isolated, candidate);
      await isolated.activateForAcceptance(base.id, signal);
      let origin = "";
      const start = async (port = 0) => {
        // The ordinary unconfigured assistant has no Driver and cannot invoke a model.
        const app = createApp(isolated!);
        app.use("/*", serveStatic({ root: env.root }));
        app.get("*", serveStatic({ path: join(env.root, "index.html") }));
        await new Promise<void>((done, reject) => {
          server = serve(
            { fetch: app.fetch, hostname: "127.0.0.1", port },
            (info) => {
              origin = `http://127.0.0.1:${info.port}`;
              done();
            },
          );
          server.once("error", reject);
        });
      };
      try {
        await start();
      } catch (error) {
        throw new BrowserEnvironmentError(
          `browser/1 隔离服务启动失败：${error instanceof Error ? error.message : error}`,
        );
      }
      context = await browser.newContext({ viewport });
      await context.route("**/*", (route) =>
        route.request().url().startsWith(`${origin}/`)
          ? route.continue()
          : route.abort(),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const command = async (action: () => Promise<unknown>) => {
        const [response] = await Promise.all([
          page.waitForResponse(
            (r) =>
              r.url() === `${origin}/api/commands` &&
              r.request().method() === "POST",
          ),
          action(),
        ]);
        return response;
      };
      const create = async (title: string) => {
        await page.goto(origin);
        const input = page.getByRole("textbox", {
          name: "添加任务",
          exact: true,
        });
        await input.fill(title);
        const response = await command(() => input.press("Enter"));
        if (!response.ok())
          throw new BrowserEnvironmentError("browser/1 合成任务创建失败");
        await page
          .getByRole("button", { name: `编辑 ${title}`, exact: true })
          .waitFor();
        const row = page.locator("[data-task-id]").filter({
          has: page.getByRole("button", {
            name: `编辑 ${title}`,
            exact: true,
          }),
        });
        const id = await row.getAttribute("data-task-id");
        if (!id)
          throw new BrowserEnvironmentError("browser/1 缺少宿主任务 DOM 标识");
        return id;
      };
      const allCases: BrowserCase[] = [
        {
          id: "host:basic-existing",
          task: "existing",
          steps: [{ kind: "open" }],
        },
        { id: "host:basic-new", task: "new", steps: [{ kind: "open" }] },
        ...cases,
      ];
      const openTask = async (taskId: string) => {
        await page.goto(origin);
        await page
          .locator('[data-filter="all"]')
          .filter({ visible: true })
          .click();
        await page
          .locator(attr("task-id", taskId))
          .locator("[data-task-open]")
          .click();
        await page.locator("[data-task-editor]").waitFor({ state: "visible" });
        if (
          !(
            await page.getByLabel("任务名称", { exact: true }).inputValue()
          ).trim()
        )
          throw new BrowserEnvironmentError("browser/1 任务详情未加载");
      };
      const runAction = async (
        step: Extract<BrowserStep, { kind: "action" }>,
        taskId: string,
      ) => {
        const workflowId = isolated!
          .composition()
          .members.find((m) => m.role === "workflow")!.pluginId;
        const owner =
          isolated!
            .extensionRegistry()
            .commands()
            .find((c) => c.id === step.action)?.providerId ?? workflowId;
        if (
          owner !== step.member &&
          !(step.member === "workflow" && owner === workflowId)
        )
          throw new Error("动作不属于冻结的目标成员");
        const registry = isolated!.extensionRegistry();
        const registered = registry.commands().find(c => c.id === step.action && c.providerId === owner);
        const schedule = registry.schedules().find(s => s.providerId === owner && s.onFire.type === "action" && s.onFire.commandId === step.action);
        if (registered?.internalOnly && schedule)
          throw new BrowserDefinitionError(`冻结页面动作 ${owner}:${step.action} 实际属于内部定时通道 ${schedule.id}；须重新编译验收路径，不能要求业务候选开放内部入口`);
        await browserAction(
          page,
          step,
          owner,
          taskId,
          () => openTask(taskId),
          command,
        );
      };
      const restartWorkspace = async (clock = acceptanceClock) => {
        const port = Number(new URL(origin).port);
        await closeServer();
        await isolated?.close();
        isolated = undefined;
        acceptanceClock = clock;
        isolated = await Workspace.open(dbPath, { acceptanceProbe: true, ...(clock ? { clock } : {}) });
        await isolated.whenSchedulesIdle();
        await start(port);
      };
      const runCaseAction = async (step: Extract<BrowserStep, { kind: "case-action" }>, taskId: string) => {
        const source = memberCases.find((c) => c.member === step.member && `member:${c.member}:${c.name}` === step.caseId);
        if (!source || hash(source) !== step.definitionHash || source.expected.kind !== "commit" ||
            !Object.hasOwn(source.expected.fields, step.field))
          throw new BrowserDefinitionError("宿主动作案例步骤没有匹配的冻结成功案例");
        const registry = isolated!.extensionRegistry();
        const registered = registry.commands().find((c) => c.id === source.action && c.providerId === source.member);
        const schedule = registry.schedules().find((s) => s.providerId === source.member && s.onFire.type === "action" && s.onFire.commandId === source.action);
        if (!registered?.internalOnly) {
          for (const action of operationPreparation(memberCases, source, "open", step.field))
            await runAction({ ...action, member: source.member }, taskId);
          await runAction({ kind: "action", member: source.member, action: source.action, input: source.input }, taskId);
          return;
        }
        if (!schedule || schedule.atKind !== "field")
          throw new BrowserDefinitionError("内部动作没有受信的字段定时通道");
        const at = Date.parse(source.fields[schedule.at]);
        if (!Number.isFinite(at))
          throw new BrowserDefinitionError("冻结到期案例缺少有效的截止前置值");
        const clock = createControllableClock(at - 60_000);
        await restartWorkspace(clock);
        await openTask(taskId);
        // Full Given is prepared through real pages; the field-only fresh-task shortcut
        // cannot omit the deadline needed to arm the scheduler.
        for (const action of operationPreparation(memberCases.filter((c) => c.action !== source.action), source))
          await runAction({ ...action, member: source.member }, taskId);
        const before = isolated!.read(taskId);
        if (before.state !== source.state || Object.entries(source.fields).some(([k, v]) => before.fields[k] !== v) ||
            before.fields[step.field] === source.expected.fields[step.field])
          throw new Error("真实页面未准备冻结的到期前置状态，或到期效果已提前出现");
        await clock.advance(59_999);
        await isolated!.whenSchedulesIdle();
        const early = isolated!.read(taskId);
        if (early.revision !== before.revision || hash(early.fields) !== hash(before.fields))
          throw new Error("浏览器验收的定时效果提前触发");
        await clock.advance(1);
        await isolated!.whenSchedulesIdle();
        const after = isolated!.read(taskId);
        if (after.revision <= before.revision || after.state !== source.expected.state ||
            Object.entries(source.expected.fields).some(([k, v]) => after.fields[k] !== v))
          throw new Error("浏览器验收的真实调度未产生冻结效果");
        await openTask(taskId);
      };
      const existing = new Map<string, string>();
      for (const [index, c] of allCases.entries()) {
        if (c.prepare && c.task !== "existing")
          throw new BrowserEnvironmentError("历史准备仅支持基础版本已有任务");
        if (c.task !== "existing") continue;
        const preparationBase = c.prepare
          ? formal.release.get(c.prepare.baseVersion)
          : base;
        if (isolated.activeVersion().id !== preparationBase.id) {
          importCompositionVersions(formal, isolated, preparationBase);
          await isolated.activateForAcceptance(preparationBase.id, signal);
        }
        const taskId = await create(`${fixtures.existing} ${index}`);
        existing.set(c.id, taskId);
        if (!c.prepare) continue;
        const receipt: NonNullable<BrowserEvidence["preparations"]>[number] = {
          caseId: c.id,
          viewport,
          sourceHash: c.prepare.sourceHash,
          baseVersion: c.prepare.baseVersion,
          expected: c.prepare.expected,
          actual: { state: "", fields: {} },
          status: "passed",
        };
        try {
          await openTask(taskId);
          for (const action of c.prepare.actions) {
            signal.throwIfAborted();
            await runAction(action, taskId);
          }
          const task = isolated!.read(taskId);
          receipt.actual = { state: task.state, fields: task.fields };
          if (hash(receipt.actual) !== hash(receipt.expected))
            throw new Error("基础版本实际历史状态与冻结成功案例不符");
        } catch (error) {
          signal.throwIfAborted();
          receipt.status = "failed";
          receipt.diagnostic =
            error instanceof Error ? error.message : String(error);
          receipt.screenshot = join(
            directory,
            `${viewportIndex}-${index}-preparation-failed.png`,
          );
          await page.screenshot({ path: receipt.screenshot, fullPage: true });
        }
        evidence.preparations!.push(receipt);
        await writeFile(
          join(directory, "evidence.json"),
          JSON.stringify(evidence, null, 2),
        );
        if (receipt.status === "failed")
          throw new BrowserEnvironmentError(
            `browser/1 基础版本历史准备失败：${receipt.diagnostic}`,
            evidence,
          );
      }
      await isolated.activateForAcceptance(candidate.id, signal);
      for (const [index, c] of allCases.entries()) {
        const title = `${fixtures.new} ${index}`;
        const taskId =
          c.task === "existing" ? existing.get(c.id)! : await create(title);
        const initial = {
          title:
            c.task === "existing" ? `${fixtures.existing} ${index}` : title,
          description: "",
        };
        fixtureTasks.push({
          viewport,
          caseId: c.id,
          task: isolated!.read(taskId),
          initial,
        });
        evidence.fixtureHash = hash({
          definition: fixtures,
          tasks: fixtureTasks,
        });
        await writeFile(
          join(directory, "fixtures.json"),
          JSON.stringify(
            { definition: fixtures, tasks: fixtureTasks },
            null,
            2,
          ),
        );
        const result: BrowserCaseResult = {
          caseId: c.id,
          requirementIds: requirements
            .filter((r) =>
              r.checks.some(
                (ref) => ref.checker === "browser/1" && ref.caseId === c.id,
              ),
            )
            .map((r) => r.id),
          viewport,
          status: "passed",
          phase: "candidate",
          classification:
            c.classification ??
            (c.id.startsWith("host:")
              ? "system-protection"
              : "frozen-business"),
          ...(c.obligationId ? { obligationId: c.obligationId } : {}),
        };
        let actual = "";
        let expected: BrowserStep = { kind: "open" };
        const open = () => openTask(taskId);
        try {
          await open();
          for (const step of c.steps) {
            signal.throwIfAborted();
            expected = step;
            actual = "";
            const editor = page.locator("[data-task-editor]");
            if (step.kind === "open") await open();
            else if (step.kind === "refresh") {
              await page.reload();
              await open();
            } else if (step.kind === "restart") {
              await restartWorkspace();
              await open();
            } else if (step.kind === "edit") {
              if (step.title !== undefined)
                await page
                  .getByLabel("任务名称", { exact: true })
                  .fill(step.title);
              if (step.description !== undefined)
                await page
                  .getByLabel("备注", { exact: true })
                  .fill(step.description);
              const response = await command(() =>
                editor
                  .getByRole("button", { name: "保存", exact: true })
                  .click(),
              );
              if (!response.ok()) throw new Error("编辑任务被拒绝");
              await open();
            } else if (step.kind === "task") {
              const expectedTitle = step.title ?? initial.title;
              const expectedDescription =
                step.description ?? initial.description;
              expected = {
                kind: "task",
                title: expectedTitle,
                description: expectedDescription,
              };
              const title = await page
                .getByLabel("任务名称", { exact: true })
                .inputValue();
              const description = await page
                .getByLabel("备注", { exact: true })
                .inputValue();
              actual = JSON.stringify({ title, description });
              if (
                title !== expectedTitle ||
                description !== expectedDescription
              )
                throw new Error("标题或备注不符合预期");
            } else if (step.kind === "action") {
              await runAction(step, taskId);
            } else if (step.kind === "case-action") {
              await runCaseAction(step, taskId);
            } else if (step.kind === "action-blocked") {
              const composition = isolated!.composition();
              const action = composition.workflow.actions.find(a => a.id === step.action);
              const workflow = composition.members.find(m => m.role === "workflow")!.pluginId;
              const owner = action?.providerId ?? workflow;
              if (!action || owner !== step.member && !(step.member === "workflow" && owner === workflow))
                throw new Error("禁止动作引用不存在或不属于目标成员");
              const detailButton = editor.locator(attr("provider", owner)).locator(attr("action-id", step.action));
              const button = await detailButton.count() ? detailButton : page.locator(attr("task-id", taskId)).locator(attr("action-id", step.action));
              if (await button.count() > 1) throw new Error("禁止动作身份不唯一");
              const before = isolated!.read(taskId);
              if (await button.isVisible() && await button.isEnabled()) {
                await runAction({ ...step, kind: "action" }, taskId);
                if (await page.locator("[data-action-form]").isVisible())
                  throw new Error("禁止动作仍请求未定义的输入，未证明不可执行");
              }
              const after = isolated!.read(taskId);
              actual = JSON.stringify({ state: after.state, fields: after.fields });
              if (hash({ state: before.state, fields: before.fields }) !== hash({ state: after.state, fields: after.fields }))
                throw new Error("禁止动作改变了任务");
              await open();
            } else if (step.kind === "form-invalid") {
              await runAction({kind:"action",member:step.member,action:step.action},taskId);
              const form=page.locator("[data-action-form]");
              await form.waitFor({state:"visible"});
              const fields=await form.locator("[data-input-field]").all();
              for (const field of fields) {
                const key=await field.getAttribute("data-input-field");
                if(!key)throw new BrowserEnvironmentError("原生表单缺少稳定字段 ID");
                await field.fill(step.input[key]??"");
              }
              const target=form.locator(attr("input-field",step.field));
              if(!await target.evaluate((field:HTMLTextAreaElement)=>field.required&&field.validity.valueMissing&&!field.validity.valid))
                throw new Error("冻结必填字段没有触发原生空值校验");
              const before=hash(isolated!.read(taskId));
              let submitted=false;
              const observe=(request:import("playwright").Request)=>{if(request.method()==="POST"&&new URL(request.url()).pathname==="/api/commands")submitted=true;};
              page.on("request",observe);
              try {await form.locator('button[type="submit"]').click();}
              finally {page.off("request",observe);}
              actual=JSON.stringify({submitted,unchanged:before===hash(isolated!.read(taskId))});
              if(submitted||before!==hash(isolated!.read(taskId))||!await form.isVisible())
                throw new Error("原生必填失败仍提交了动作或改变任务");
            } else if (step.kind === "ui-identity") {
              const composition=isolated!.composition();
              if(step.workflow){
                const w=composition.workflow;
                if(w.id!==step.workflow.id || step.workflow.fields.some(f=>!w.fields.some(actual=>actual.key===f.key)) || step.workflow.actions.some(a=>!w.actions.some(actual=>actual.id===a.id)))throw new Error("主工作流字段或动作身份已变化");
                if(await editor.getAttribute("data-workflow-id")!==step.workflow.id)throw new Error("页面主工作流身份与冻结基线不一致");
                await editor.getByLabel("任务名称",{exact:true}).waitFor({state:"visible"});
                await editor.getByLabel("备注",{exact:true}).waitFor({state:"visible"});
                for(const f of step.workflow.fields)if(Object.hasOwn(isolated!.read(taskId).fields,f.key))await editor.locator(attr("provider","workflow")+attr("contribution","workflow")).locator(attr("field",f.key)).waitFor({state:"visible"});
              }
              const contributions = composition.uiContributions;
              const observed = step.contributions.map((c) => {
                const current = contributions.find(
                  (ui) =>
                    ui.providerId === c.member && ui.id === c.contribution,
                );
                return current
                  ? {
                      member: current.providerId,
                      contribution: current.id,
                      fields: current.fields.map((f) => f.key),
                      actions: current.actions.map((a) => a.commandId),
                    }
                  : null;
              });
              actual = JSON.stringify({workflow:step.workflow ? composition.workflow : undefined,contributions:observed});
              if (
                step.contributions.some((c, index) => {
                  const current = observed[index];
                  return (
                    !current ||
                    c.fields.some((f) => !current.fields.includes(f)) ||
                    c.actions.some((a) => !current.actions.includes(a))
                  );
                })
              )
                throw new Error("界面贡献、字段或动作身份已变化");
              for (const c of step.contributions) {
                const section = editor.locator(
                  attr("provider", c.member) +
                    attr("contribution", c.contribution),
                );
                await section.waitFor({ state: "visible" });
                for (const key of c.fields)
                  await section
                    .locator(attr("field", key))
                    .waitFor({ state: "visible" });
              }
            } else if (
              step.kind === "field" ||
              step.kind === "action-visible"
            ) {
              const composition = isolated!.composition();
              if (step.kind === "action-visible") {
                const workflow = composition.members.find((m) => m.role === "workflow")!.pluginId;
                const owner = step.member === "workflow" ? workflow : step.member;
                const declared = isolated!.extensionRegistry().commands().some((c) => c.id === step.action && c.providerId === owner) ||
                  composition.workflow.actions.some((a) => a.id === step.action && (a.providerId ?? workflow) === owner);
                if (!declared) throw new Error("可见动作身份不存在或不属于目标成员");
                if (!step.visible && !step.contribution) {
                  const buttons = [
                    ...await editor.locator(attr("provider", owner)).locator(attr("action-id", step.action)).all(),
                    ...await page.locator(attr("task-id", taskId)).locator(attr("action-id", step.action)).all(),
                  ];
                  actual = String((await Promise.all(buttons.map((button) => button.isVisible()))).some(Boolean));
                  if (actual === "true") throw new Error("可见动作不符合预期");
                  continue;
                }
                if (step.contribution && step.member !== "workflow" &&
                    !composition.uiContributions?.some((c) => c.id === step.contribution && c.providerId === owner))
                  throw new Error("浏览器贡献身份不存在或不唯一");
              }
              let contribution = step.contribution;
              if (!contribution) {
                if (step.member === "workflow") contribution = "workflow";
                else {
                  const matches = (composition.uiContributions ?? []).filter(
                    (c) =>
                      c.providerId === step.member &&
                      (step.kind === "field"
                        ? c.fields.some((f) => f.key === step.field)
                        : c.actions.some((a) => a.commandId === step.action)),
                  );
                  if (matches.length !== 1)
                    throw new Error("浏览器贡献身份不存在或不唯一");
                  contribution = matches[0].id;
                }
              }
              if (step.kind === "field") {
                const field = editor
                  .locator(
                    attr("provider", step.member) +
                      attr("contribution", contribution),
                  )
                  .locator(attr("field", step.field));
                if (step.visible === false) {
                  await field.waitFor({ state: "hidden" });
                  actual = "absent";
                } else {
                  await field.waitFor({ state: "visible" });
                  actual = (await field.innerText()).trim();
                  if (actual !== step.value)
                    throw new Error("可见字段值不符合预期");
                }
              } else {
                const button =
                  step.member === "workflow"
                    ? page
                        .locator(attr("task-id", taskId))
                        .locator(attr("action-id", step.action))
                    : editor
                        .locator(
                          attr("provider", step.member) +
                            attr("contribution", contribution),
                        )
                        .locator(attr("action-id", step.action));
                actual = String(await button.isVisible());
                if ((actual === "true") !== step.visible)
                  throw new Error("可见动作不符合预期");
              }
            } else if (step.kind === "error") {
              const alert = page
                .getByRole("alert")
                .filter({ hasText: step.text });
              await alert.waitFor({ state: "visible" });
              actual = await alert.innerText();
              if (!actual.includes(step.text))
                throw new Error("错误信息不符合预期");
            } else throw new BrowserEnvironmentError("browser/1 收到未实现的宿主步骤");
          }
          if (pageErrors.length)
            throw new Error(`页面异常：${pageErrors.join("；")}`);
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof BrowserDefinitionError) {
            result.status = "failed";
            result.expected = expected;
            result.actual = "internal-schedule-channel";
            result.diagnostic = error.message;
            result.screenshot = join(directory, `${viewportIndex}-${index}-definition-failed.png`);
            await page.screenshot({path:result.screenshot,fullPage:true});
            evidence.results.push(result);
            await writeFile(join(directory,"evidence.json"),JSON.stringify(evidence,null,2));
            error.message = `browser/1 冻结案例 ${c.id}（需求 ${result.requirementIds.join(",")}）不可执行：${error.message}`;
            throw error;
          }
          if (error instanceof BrowserEnvironmentError) throw error;
          if (c.id.startsWith("host:basic-") || !browser.isConnected())
            throw new BrowserEnvironmentError(
              `browser/1 基础页面或检查器异常：${error instanceof Error ? error.message : error}`,
            );
          result.status = "failed";
          result.expected = expected;
          result.actual =
            actual || (await page.locator("body").innerText()).slice(0, 10000);
          result.diagnostic =
            error instanceof Error ? error.message : String(error);
          result.screenshot = join(
            directory,
            `${viewportIndex}-${index}-failed.png`,
          );
          await page.screenshot({ path: result.screenshot, fullPage: true });
        }
        evidence.results.push(result);
        await writeFile(
          join(directory, "evidence.json"),
          JSON.stringify(evidence, null, 2),
        );
      }
      await context.close();
      context = undefined;
      await closeServer();
      await isolated?.close();
      isolated = undefined;
    }
    const failed = evidence.results.find((r) => r.status === "failed");
    if (failed)
      throw new BrowserAssertionError(
        `browser/1 业务断言失败：需求 ${failed.requirementIds.join(",") || "基础页面"}；案例 ${failed.caseId}；预期 ${JSON.stringify(failed.expected)}；实际 ${JSON.stringify(failed.actual)}；${failed.diagnostic}；截图 ${failed.screenshot}`,
        evidence,
      );
    return evidence;
  } catch (error) {
    const failure = signal.aborted ? signal.reason : error;
    await writeFile(
      join(directory, "failure.json"),
      JSON.stringify(
        {
          error: failure instanceof Error ? failure.message : String(failure),
          cancelled: signal.aborted,
          evidence,
        },
        null,
        2,
      ),
    );
    if (signal.aborted)
      throw new BrowserCancelledError(signal.reason, evidence);
    if (error instanceof BrowserDefinitionError) {
      error.evidence = evidence;
      throw error;
    }
    if (error instanceof BrowserAssertionError) throw error;
    throw new BrowserEnvironmentError(
      error instanceof Error ? error.message : String(error),
      evidence,
    );
  } finally {
    signal.removeEventListener("abort", abort);
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await closeServer();
    await isolated?.close();
    await writeFile(
      join(directory, "cleanup.json"),
      JSON.stringify(
        {
          browserClosed: !browser?.isConnected(),
          serviceClosed: !server,
          workspaceClosed: true,
          aborted: signal.aborted,
        },
        null,
        2,
      ),
    );
  }
}
