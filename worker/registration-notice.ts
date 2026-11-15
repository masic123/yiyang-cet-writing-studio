import type { D1Database } from "@cloudflare/workers-types";
import { HttpError } from "../src/lib/http";
import { REGISTRATION_NOTICE_VERSION } from "../src/lib/registration-notice";

const initialized = new WeakMap<D1Database, Promise<unknown>>();

export function requireRegistrationNotice(input: { acceptNotice?: boolean; noticeVersion?: string }) {
  if (input.acceptNotice !== true)
    throw new HttpError(400, "请先阅读并勾选同意《用户须知》，再注册账号。", "REGISTRATION_NOTICE_REQUIRED");
  if (input.noticeVersion !== REGISTRATION_NOTICE_VERSION)
    throw new HttpError(400, "用户须知已更新，请刷新页面并重新阅读、勾选后注册。", "REGISTRATION_NOTICE_UPDATED");
}

/** The receipt is committed with the new account in the same identity database. */
export async function registrationNoticeStatement(db: D1Database, userId: string, acceptedAt: string) {
  if (!initialized.has(db)) {
    const init = Promise.resolve().then(() => db.prepare(
      "CREATE TABLE IF NOT EXISTS registration_notice_acceptances(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,site TEXT NOT NULL,notice_version TEXT NOT NULL,accepted_at TEXT NOT NULL,PRIMARY KEY(user_id,site,notice_version))",
    ).run()).catch(error => { initialized.delete(db); throw error; });
    initialized.set(db, init);
  }
  await initialized.get(db);
  return db.prepare(
    "INSERT INTO registration_notice_acceptances(user_id,site,notice_version,accepted_at) VALUES(?,?,?,?)",
  ).bind(userId, "cet", REGISTRATION_NOTICE_VERSION, acceptedAt);
}
