import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { recordRunnerCompletion } from "../../scripts/lib/stability-eval/runner-completion.js";
import {
  sealArchive,
  verifyArchive,
  writeVerifiedJson,
} from "../../scripts/lib/stability-eval/archive.js";

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "stability-runner-terminal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "batch");
  mkdirSync(root);
  const startedAt = new Date().toISOString();
  const child = spawnSync(process.execPath, ["-e", "process.exit(1)"]);
  assert.equal(child.status, 1);
  return {
    root,
    exit: {
      startedAt,
      pid: child.pid,
      exitCode: child.status,
      signal: child.signal,
    },
  };
}

test("真实子进程退出事实先持久化，再运行任何可能失败的源码或归档校验", (t) => {
  const { root, exit } = fixture(t);
  const completion = recordRunnerCompletion(root, exit, {
    terminalAlreadyWritten: () => existsSync(`${root}-runner-terminal.json`),
    sourceUnchanged: () => true,
  });
  assert.equal(completion.integrityVerified, true);
  const terminal = JSON.parse(readFileSync(completion.terminalPath, "utf8"));
  assert.equal(terminal.exitCode, 1, "业务验收失败与证据完整性应分开保留");
  assert.equal(terminal.pid, exit.pid);
  assert.equal(terminal.signal, null);
  assert.ok(terminal.exitObservedAt);
});

test("源码消失或校验返回false仍保留退出事实及全部诊断，不破坏已封存子归档", (t) => {
  const { root, exit } = fixture(t);
  writeVerifiedJson(join(root, "summary.json"), {
    executionComplete: true,
    acceptancePassed: false,
    exitCode: 1,
  });
  const anchor = sealArchive(root);
  const completion = recordRunnerCompletion(root, exit, {
    sourceUnchanged: () => {
      readFileSync(join(root, "missing-source.ts"));
      return true;
    },
    snapshotClean: () => false,
    batchArchive: () => {
      verifyArchive(root, anchor);
      return true;
    },
  });
  assert.equal(completion.integrityVerified, false);
  assert.equal(completion.checks.sourceUnchanged.passed, false);
  assert.match(completion.checks.sourceUnchanged.diagnostic ?? "", /ENOENT/);
  assert.equal(completion.checks.snapshotClean.passed, false);
  assert.equal(
    completion.checks.batchArchive.passed,
    true,
    "一个校验失败不能阻止其他证据被记录",
  );
  assert.equal(
    JSON.parse(readFileSync(completion.terminalPath, "utf8")).exitCode,
    1,
  );
  verifyArchive(root, anchor);
});

test("终态回执不可覆盖或重试；重入不得执行第二次后置校验", (t) => {
  const { root, exit } = fixture(t);
  const first = recordRunnerCompletion(root, exit, { source: () => true });
  const terminal = readFileSync(first.terminalPath, "utf8");
  let calls = 0;
  assert.throws(
    () =>
      recordRunnerCompletion(
        root,
        { ...exit, exitCode: 0 },
        {
          source: () => {
            calls++;
            return true;
          },
        },
      ),
    /EEXIST/,
  );
  assert.equal(calls, 0);
  assert.equal(readFileSync(first.terminalPath, "utf8"), terminal);
});

test("缺少后置校验不能宣称归档完整，退出事实仍被保留", (t) => {
  const {root, exit}=fixture(t);
  const completion=recordRunnerCompletion(root,exit,{});
  assert.equal(completion.integrityVerified,false);
  assert.equal(JSON.parse(readFileSync(completion.terminalPath,"utf8")).exitCode,1);
});
