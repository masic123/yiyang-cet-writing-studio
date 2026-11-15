import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProviderCompletion } from "../src/lib/provider-completion";

const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const first = chunk({ model: "deepseek-v4.1-flash", choices: [{ index: 0, delta: { content: '{"ok":' } }] });
const last = chunk({ model: "deepseek-v4.1-flash", choices: [{ index: 0, delta: { content: "true}" }, finish_reason: "stop" }] });
test("complete relay SSE survives heartbeat comments and reconstructs the JSON answer", () => {
  const completion = parseProviderCompletion(": keepalive\n\n" + first + last + "data: [DONE]\n\n");
  assert.equal(completion.choices[0].message.content, '{"ok":true}');
});
test("empty, interrupted, truncated or mixed-model streams never become feedback", () => {
  for (const text of [": keepalive\n\n", first, first + last, first + last.replace('"stop"', '"length"') + "data: [DONE]\n\n", first + last.replace("deepseek-v4.1-flash", "other") + "data: [DONE]\n\n"]) {
    assert.throws(() => parseProviderCompletion(text));
  }
});
test("the native JSON response remains supported", () => {
  const completion = { model: "deepseek-flash", choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] };
  assert.deepEqual(parseProviderCompletion(JSON.stringify(completion)), completion);
});
