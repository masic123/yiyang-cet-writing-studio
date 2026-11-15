export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

/** A late 401 from an older request must not discard a newly restored session. */
export function createApiClient(expiredEvent: string) {
  let checking: Promise<boolean | undefined> | null = null;
  let expiredNotified = false;
  function checkSession() {
    if (!checking) checking = (async () => {
      try {
        const response = await fetch("/api/auth", { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) return undefined;
        const data = await response.json();
        if (data.user === null) return false;
        return typeof data.user?.id === "string" ? true : undefined;
      } catch { return undefined; }
    })().finally(() => { checking = null; });
    return checking;
  }
  return async function api<T>(url: string, options?: RequestInit): Promise<T> {
    const send = async () => {
      const response = await fetch(url, { ...options, credentials: "same-origin", headers: { "Content-Type": "application/json", ...options?.headers }, cache: "no-store" });
      let data;
      try { data = await response.json(); }
      catch { throw new Error("暂时无法连接网站，请稍后重试。"); }
      return { response, data };
    };
    let { response, data } = await send();
    const authEndpoint = url.split("?")[0].endsWith("/api/auth");
    if (response.status === 401 && !authEndpoint && (!data.code || data.code === "LOGIN_REQUIRED")) {
      const active = await checkSession();
      if (active) {
        expiredNotified = false;
        ({ response, data } = await send());
      } else if (active === false && !expiredNotified) {
        expiredNotified = true;
        window.dispatchEvent(new Event(expiredEvent));
      }
      // A network failure or upstream credential error does not prove the user logged out.
    }
    if (!response.ok) throw new ApiError(data.error || "操作失败，请稍后重试。", response.status, data.code);
    if (authEndpoint && data.user?.id) expiredNotified = false;
    return data as T;
  };
}
