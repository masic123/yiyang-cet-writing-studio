export type TargetPreference = { ownerId: string; target: number | null; version: number; updatedAt: string | null };
export type TargetSyncStatus = "guest" | "loading" | "default" | "saving" | "saved" | "error";
export type TargetSyncState = { ownerId: string | null | undefined; target: number; status: TargetSyncStatus };
type PendingTarget = { target: number; revision: number; migration: boolean };
type Options = {
  defaultTarget: number;
  valid: (target: number) => boolean;
  readLocal: (owner: string | null) => number | null;
  writeLocal: (owner: string | null, target: number) => void;
  read: (owner: string, signal: AbortSignal) => Promise<TargetPreference>;
  write: (owner: string, target: number, version: number, signal: AbortSignal) => Promise<TargetPreference>;
  changed: (state: TargetSyncState) => void;
  apply: (target: number, owner: string | null) => void;
};

/** One account, one ordered write flight. Drafts never initialize this setting. */
export function createTargetPreferenceSync(options: Options) {
  let owner: string | null | undefined;
  let epoch = 0, version = 0, revision = 0;
  let confirmedTarget: number | null | undefined;
  let value = options.defaultTarget, loaded = false, writing = false, reading = false;
  let legacy: number | null = null;
  let pending: PendingTarget | null = null;
  let cancellation = new AbortController();
  let state: TargetSyncState = { ownerId: undefined, target: value, status: "loading" };
  const local = (id: string | null) => {
    try { const target = options.readLocal(id); return target !== null && options.valid(target) ? target : null; }
    catch { return null; }
  };
  const remember = (id: string | null, target: number) => { try { options.writeLocal(id, target); } catch {} };
  const current = (token: number) => token === epoch && owner !== undefined && !cancellation.signal.aborted;
  function publish(status: TargetSyncStatus) {
    state = { ownerId: owner, target: value, status };
    options.changed(state);
  }
  function apply(target: number) {
    value = target;
    if (owner !== undefined) options.apply(target, owner);
  }
  function validate(preference: TargetPreference, id: string): TargetPreference {
    if (preference?.ownerId !== id || !Number.isSafeInteger(preference.version) || preference.version < 0 ||
      (preference.target === null ? preference.version !== 0 : !options.valid(preference.target) || preference.version === 0))
      throw new Error("Invalid account target response");
    return preference;
  }
  function observe(preference: TargetPreference) {
    if (preference.version < version) return false;
    if (preference.version === version && confirmedTarget !== undefined && preference.target !== confirmedTarget)
      throw new Error("Inconsistent account target version");
    version = preference.version;
    confirmedTarget = preference.target;
    loaded = true;
    return true;
  }
  function accept(preference: TargetPreference) {
    if (!observe(preference)) return;
    pending = null;
    if (preference.target !== null) {
      legacy = null;
      apply(preference.target);
      remember(preference.ownerId, preference.target);
      publish("saved");
    } else {
      apply(options.defaultTarget);
      publish("default");
    }
  }
  async function drain(token: number) {
    if (!current(token) || !owner || !loaded || writing || !pending) return;
    writing = true;
    const id = owner, signal = cancellation.signal;
    let conflicts = 0;
    try {
      while (current(token) && pending) {
        const sent: PendingTarget = pending;
        publish("saving");
        try {
          const preference = validate(await options.write(id, sent.target, version, signal), id);
          if (!current(token)) return;
          if (!observe(preference)) {
            if (++conflicts > 3) throw new Error("Repeated stale account acknowledgements");
            continue;
          }
          if (pending && preference.target === pending.target) {
            accept(preference);
          } else if (pending === sent) {
            throw new Error("Account target was not saved");
          }
        } catch (error) {
          if (!current(token)) return;
          if ((error as { status?: number })?.status !== 409 || ++conflicts > 3) {
            publish("error");
            return;
          }
          // A newer account value wins over an old-cache migration. Only an
          // explicit, still-current user selection may retry against its version.
          const preference = validate(await options.read(id, signal), id);
          if (!current(token)) return;
          if (!observe(preference)) throw new Error("Stale account conflict response");
          if (!pending || pending.migration || preference.target === pending.target) accept(preference);
        }
      }
    } catch {
      if (current(token)) publish("error");
    } finally {
      if (current(token)) writing = false;
    }
  }
  async function pull(token: number) {
    if (!current(token) || !owner || reading || writing) return;
    const id = owner, signal = cancellation.signal;
    reading = true;
    try {
      const preference = validate(await options.read(id, signal), id);
      if (!current(token)) return;
      if (!observe(preference)) return;
      if (pending && !pending.migration) {
        if (preference.target === pending.target) accept(preference);
      } else if (preference.target !== null) {
        accept(preference);
      } else if (legacy !== null) {
        pending = { target: legacy, revision: ++revision, migration: true };
      } else {
        accept(preference);
      }
    } catch {
      if (current(token)) publish("error");
      return;
    } finally {
      if (current(token)) reading = false;
    }
    if (current(token) && pending) await drain(token);
  }
  return {
    setOwner(id: string | null) {
      if (owner === id) return;
      cancellation.abort();
      cancellation = new AbortController();
      const token = ++epoch;
      owner = id; version = 0; confirmedTarget = undefined; loaded = !id; writing = false; reading = false; pending = null;
      legacy = id ? local(id) : null;
      apply(local(id) ?? options.defaultTarget);
      publish(id ? "loading" : "guest");
      if (id) void pull(token);
    },
    choose(target: number) {
      if (owner === undefined || !options.valid(target)) return;
      apply(target);
      remember(owner, target);
      if (!owner) { publish("guest"); return; }
      pending = { target, revision: ++revision, migration: false };
      publish("saving");
      if (loaded) void drain(epoch);
      else void pull(epoch);
    },
    refresh() { return pull(epoch); },
    retry() { return pull(epoch); },
    valueFor(id: string | null) { return owner === id ? value : local(id) ?? options.defaultTarget; },
    snapshot() { return state; },
    stop() {
      cancellation.abort();
      epoch++;
      owner = undefined;
      pending = null; reading = false; writing = false; loaded = false;
    },
  };
}
