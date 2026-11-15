"use client";
import * as Dialog from "@radix-ui/react-dialog";
import { X, ArrowRight, SignIn, SpinnerGap } from "@phosphor-icons/react";
import { useEffect, useId, useState } from "react";
import type { User } from "@/lib/types";
import { createApiClient } from "@/lib/api-client";
import { REGISTRATION_NOTICE_DATE, REGISTRATION_NOTICE_VERSION, registrationNoticeSections } from "@/lib/registration-notice";
export { ApiError } from "@/lib/api-client";
export const api = createApiClient("cet:session-expired");
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className={`modal ${wide ? "modal-wide" : ""}`}>
          <div className="modal-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="关闭窗口">
              <X size={21} />
            </Dialog.Close>
          </div>
          <Dialog.Description className={description ? "muted" : "sr-only"}>
            {description || title}
          </Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function AuthDialog({
  open,
  onOpenChange,
  onSuccess,
  invitationRequired,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (user: User) => void;
  invitationRequired: boolean;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [noticeAccepted, setNoticeAccepted] = useState(false);
  const noticeId = useId();

  useEffect(() => { setNoticeAccepted(false); }, [open]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    if (mode === "register" && (!noticeAccepted || fields.get("acceptNotice") !== "on")) {
      setError("请先阅读并勾选同意《用户须知》，再注册账号。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const data = await api<{ user: User }>("/api/auth", {
        method: "POST",
        body: JSON.stringify({
          action: mode,
          email: fields.get("email"),
          password: fields.get("password"),
          ...(mode === "register"
            ? { name: fields.get("name"), code: fields.get("code") || "", acceptNotice: true, noticeVersion: REGISTRATION_NOTICE_VERSION }
            : {}),
        }),
      });
      onSuccess(data.user);
      onOpenChange(false);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={(v) => {
        if (!busy) {
          setError("");
          setNoticeAccepted(false);
          onOpenChange(v);
        }
      }}
      title={mode === "login" ? "欢迎回到练习室" : "开始你的写译练习"}
      description="译洋与莎试笔雅共用账号，使用同一邮箱和密码登录。两站的练习与批改记录分别保存。"
    >
      <div className="segment auth-tabs" role="group" aria-label="选择登录或注册">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setMode("login");
            setNoticeAccepted(false);
            setError("");
          }}
          aria-pressed={mode === "login"}
        >
          登录
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setMode("register");
            setNoticeAccepted(false);
            setError("");
          }}
          aria-pressed={mode === "register"}
        >
          注册账号
        </button>
      </div>
      <form onSubmit={submit} className="form-stack" aria-label={mode === "login" ? "邮箱登录" : "邮箱注册"} aria-busy={busy}>
        {mode === "register" && (
          <label>
            昵称
            <input
              name="name"
              autoComplete="nickname"
              required
              disabled={busy}
              maxLength={40}
              placeholder="怎么称呼你"
            />
          </label>
        )}
        <label>
          邮箱
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            disabled={busy}
            maxLength={200}
            placeholder="you@example.com"
          />
        </label>
        <label>
          密码
          <input
            name="password"
            type="password"
            autoComplete={
              mode === "login" ? "current-password" : "new-password"
            }
            required
            disabled={busy}
            minLength={8}
            maxLength={128}
            placeholder="至少 8 个字符"
          />
        </label>
        {mode === "register" && invitationRequired && (
          <label>
            邀请码
            <input name="code" autoComplete="off" required disabled={busy} />
          </label>
        )}
        {mode === "register" && (
          <div className="registration-consent">
            <details className="registration-notice">
              <summary aria-controls={noticeId}>阅读《用户须知》</summary>
              <div id={noticeId} className="registration-notice-content" role="region" aria-label="用户须知全文" tabIndex={0}>
                <p className="registration-notice-date">更新日期：{REGISTRATION_NOTICE_DATE}</p>
                {registrationNoticeSections.map(section => (
                  <section key={section.title}>
                    <h3>{section.title}</h3>
                    <p>{section.text}</p>
                  </section>
                ))}
              </div>
            </details>
            <label className="registration-notice-check">
              <input name="acceptNotice" type="checkbox" required checked={noticeAccepted} disabled={busy} onChange={event => setNoticeAccepted(event.target.checked)} />
              <span>我已阅读并同意《用户须知》</span>
            </label>
          </div>
        )}
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
        <button className="button primary full" disabled={busy || (mode === "register" && !noticeAccepted)} type="submit">
          {busy ? (
            <SpinnerGap className="spin" size={18} />
          ) : (
            <SignIn size={18} />
          )}{" "}
          {busy ? "正在处理" : mode === "login" ? "登录" : "注册账号"}
          <ArrowRight size={18} />
        </button>
        {mode === "login" && <p className="small muted">
          请妥善保存密码。当前版本暂未提供邮件找回功能。
        </p>}
      </form>
    </Modal>
  );
}
