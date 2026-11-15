export type DraftSaveMeta = { id: string; version: number };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Compare stored inputs without changing any answer text or array ordering. */
export function sameDraftInput(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

/** A saved snapshot may be left only while it is still the active, unchanged exercise. */
export function savedDraftSwitchStatus(
  saved: { scope: string; input: unknown },
  current: { scope: string; input: unknown },
): "ready" | "changed" | "stale" {
  if (saved.scope !== current.scope) return "stale";
  return sameDraftInput(saved.input, current.input) ? "ready" : "changed";
}

export function reconcileLocalDraftMeta(
  local: { input: unknown; meta: DraftSaveMeta | null },
  cloud: { id: string; version: number; input: unknown }[],
): { meta: DraftSaveMeta | null; detached: boolean } {
  if (!local.meta) return { meta: null, detached: false };
  const saved = cloud.find(draft => draft.id === local.meta!.id);
  if (saved && (saved.version === local.meta.version || sameDraftInput(saved.input, local.input)))
    return { meta: { id: saved.id, version: saved.version }, detached: false };
  // The local answer survives, but its stale version cannot overwrite a different cloud answer.
  return { meta: null, detached: true };
}

/** A synchronous gate closes the gap before React has rendered its busy state. */
export function createDraftSaveFlight<T>() {
  let active: { scope: string; signature: string; promise: Promise<T> } | null = null;
  return {
    busy(scope: string) { return active?.scope === scope; },
    run(scope: string, signature: string, operation: () => Promise<T>): Promise<T> {
      if (active?.scope === scope) {
        if (active.signature === signature) return active.promise;
        return Promise.reject(new Error("正在保存，请稍候。当前输入已保留。"));
      }
      const entry = { scope, signature, promise: null as unknown as Promise<T> };
      entry.promise = Promise.resolve().then(operation).finally(() => {
        if (active === entry) active = null;
      });
      active = entry;
      return entry.promise;
    },
  };
}
