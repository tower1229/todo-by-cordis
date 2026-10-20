import test from "node:test";
import assert from "node:assert/strict";
import { modelInput } from "../../src/evolution/model-input.js";
import { hash } from "../../src/release/storage.js";

test("长 Unicode 边界夹具无损参数化且不修改宿主冻结断言", () => {
  const text = "🧭".repeat(5001);
  const frozen = { input: { text }, expected: { text }, normal: " abc " };
  const projected = modelInput(frozen);
  assert.equal(frozen.input.text, text);
  assert.equal(projected.normal, " abc ");
  assert.deepEqual(projected.input.text, {
    $text: { unit: "🧭", count: 5001, hash: hash(text) },
  });
  assert.ok(JSON.stringify(projected).length < 1000);
});
