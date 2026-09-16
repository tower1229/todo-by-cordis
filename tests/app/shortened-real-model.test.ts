import test from "node:test";
import assert from "node:assert/strict";
import {
  REAL_MODEL_FULL_SIX_STEP_KIND,
  REAL_MODEL_SHORTENED_KIND,
  assertFormalFingerprintUnchanged,
  buildShortenedTrialHeader,
  formalWorkspaceFingerprint,
  redactSensitive,
  requireRealModelAuthorization,
} from "../../src/shared/shortened-real-model.js";

test("requireRealModelAuthorization blocks without explicit ACCEPT_REAL_MODEL", () => {
  const key = process.env.GEMINI_API_KEY;
  process.env.ACCEPT_REAL_MODEL = "";
  process.env.GEMINI_API_KEY = "test-key";
  assert.throws(() => requireRealModelAuthorization(), /ACCEPT_REAL_MODEL=1/);
  process.env.ACCEPT_REAL_MODEL = "1";
  assert.throws(() => {
    delete process.env.GEMINI_API_KEY;
    requireRealModelAuthorization();
  }, /GEMINI_API_KEY/);
  process.env.GEMINI_API_KEY = key;
  delete process.env.ACCEPT_REAL_MODEL;
});

test("buildShortenedTrialHeader distinguishes shortened trial from full six-step kind", () => {
  const header = buildShortenedTrialHeader({
    issue: "https://github.com/tower1229/todo-by-cordis/issues/33",
    parentIssue: "https://github.com/tower1229/todo-by-cordis/issues/30",
    businessRequests: ["a", "b"],
    baseCommit: "abc123",
  });
  assert.equal(header.kind, REAL_MODEL_SHORTENED_KIND);
  assert.notEqual(header.kind, REAL_MODEL_FULL_SIX_STEP_KIND);
  assert.equal(header.maxAttemptsPerPhase, 1);
  assert.equal(header.experienceInteraction, false);
  assert.deepEqual(header.businessRequests, ["a", "b"]);
  assert.match(header.note, /不覆盖/);
});

test("redactSensitive masks Gemini keys and secret fields", () => {
  const redacted = redactSensitive({
    gemini_api_key: "secret",
    nested: { authorization: "Bearer x", text: "AIzaSy0123456789012345678901234567890ab" },
  }) as Record<string, unknown>;
  assert.equal(redacted.gemini_api_key, "[REDACTED]");
  assert.equal(
    (redacted.nested as Record<string, unknown>).authorization,
    "[REDACTED]",
  );
  assert.match(
    String((redacted.nested as Record<string, unknown>).text),
    /REDACTED_GEMINI_KEY/,
  );
});

test("assertFormalFingerprintUnchanged detects composition or task drift", () => {
  const before = formalWorkspaceFingerprint({
    composition: {
      revision: 1,
      versionId: "v1",
    } as Parameters<typeof formalWorkspaceFingerprint>[0]["composition"],
    tasks: {
      total: 1,
      revision: 1,
      counts: { open: 1, done: 0 },
      tasks: [
        {
          id: "t1",
          title: "x",
          description: "",
          state: "open",
          fields: {},
          revision: 1,
          createdAt: "",
          updatedAt: "",
        },
      ],
    },
  });
  const after = { ...before, compositionRevision: 2 };
  assert.throws(
    () => assertFormalFingerprintUnchanged("planning", before, after),
    /正式任务数据或组合指针/,
  );
});
