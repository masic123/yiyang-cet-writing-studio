/** Preserve native DeepSeek controls while supporting the configured relay. */
function usesRelay(env: { DEEPSEEK_BASE_URL?: string }) {
  try {
    return new URL(env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").origin === "https://hgapi.dieqiyun.top";
  } catch { return false; }
}
export function thinkingOptions(env: { DEEPSEEK_BASE_URL?: string }, enabled: boolean) {
  const thinking = { type: enabled ? "enabled" : "disabled" };
  // This relay needs the standard effort field to disable reasoning. Without
  // it, hidden reasoning can exhaust the feedback response's token budget.
  return usesRelay(env) ? { thinking, reasoning_effort: enabled ? "high" : "none" } : { thinking };
}

/** The relay's streaming route avoids its intermittent empty JSON replies. */
export function streamOptions(env: { DEEPSEEK_BASE_URL?: string }) {
  return usesRelay(env) ? { stream: true, stream_options: { include_usage: true } } : {};
}
