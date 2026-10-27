import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("缺少浏览器时取消测试应报告宿主阻塞并退出，不能无限等待模型回调", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-ci-lifecycle-"));
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: directory,
  };
  // A separate runner must not inherit the parent test worker's context.
  delete environment.NODE_TEST_CONTEXT;
  try {
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "--test",
          "--test-reporter=tap",
          // Only this coordination probe is bounded; host run budgets are unchanged.
          "--test-timeout=3000",
          "--test-name-pattern=统一澄清审查取消后迟到回复",
          "tests/app/clarification-routing.test.ts",
        ],
        {
          env: environment,
          timeout: 10_000,
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const failure = error as Error & {
          code?: number | string;
          signal?: string | null;
          stdout?: string;
        };
        assert.equal(failure.code, 1);
        assert.equal(failure.signal, null);
        assert.match(failure.stdout ?? "", /澄清审查未启动：blocked/);
        assert.doesNotMatch(failure.stdout ?? "", /testTimeoutFailure/);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
