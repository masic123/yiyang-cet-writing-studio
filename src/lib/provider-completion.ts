// Both JSON and complete SSE are supported; partial streams never become scores.
export function parseProviderCompletion(text: string) {
  if (text.trimStart().startsWith("{")) return JSON.parse(text);
  let content = "", finish: string | null = null, done = false, seen = false;
  let model: string | undefined;
  for (const block of text.replace(/\r\n/g, "\n").split(/\n\n+/)) {
    const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    if (data === "[DONE]") { done = true; continue; }
    if (done) throw new Error("Data after completed stream");
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error("Provider stream failed");
    if (chunk.model) {
      if (model && model !== chunk.model) throw new Error("Mixed models in stream");
      model = chunk.model;
    }
    const choice = chunk.choices?.find((c: { index?: number }) => c.index === 0);
    if (!choice) continue;
    seen = true;
    if (typeof choice.delta?.content === "string") content += choice.delta.content;
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  if (!done || !seen || finish !== "stop" || !content || !model) throw new Error("Incomplete provider stream");
  return { model, choices: [{ finish_reason: finish, message: { content } }] };
}
