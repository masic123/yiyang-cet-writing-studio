"use client";
import { useEffect, useRef, useState } from "react";
import styles from "./promotion-dashboard.module.css";

type SharedReport = {
  inviter: { name: string; email: string; referralCode: string };
  summary: { registeredUsers: number; saleRedeemedUsers: number; saleRedeemedCards: number; saleRedeemedDays: number };
  users: { name: string; email: string; registeredAt: string; saleRedeemedCards: number; saleRedeemedDays: number; lastRedemptionAt: number | null }[];
  pagination: { offset: number; limit: number; total: number; hasMore: boolean };
  updatedAt: number; paymentBasis: "sale-card-redemption";
};
const time = (value: string | number) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

export default function PromotionDashboard() {
  const [token, setToken] = useState<string | null>(null);
  const [report, setReport] = useState<SharedReport | null>(null);
  const [onlyRedeemed, setOnlyRedeemed] = useState(false);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const sequence = useRef(0);
  useEffect(() => {
    const read = () => {
      const value = new URLSearchParams(window.location.hash.slice(1)).get("key") || "";
      setToken(value.length === 64 && /^[a-f0-9]{64}$/.test(value) ? value : ""); setReport(null); setOffset(0); setBusy(false); setError(""); setCopied(false);
    };
    read(); window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  useEffect(() => {
    if (!token) return;
    let disposed = false;
    let controller: AbortController | null = null;
    const refresh = async () => {
      controller?.abort(); const activeController = new AbortController(); controller = activeController;
      const number = ++sequence.current;
      setBusy(true);
      const timeout = window.setTimeout(() => activeController.abort(), 15000);
      try {
        const params = new URLSearchParams({ offset: String(offset), limit: "50", onlyRedeemed: String(onlyRedeemed) });
        const response = await fetch(`/api/membership/promotion-share?${params}`, {
          headers: { Authorization: `Bearer ${token}` }, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: activeController.signal,
        });
        if (!response.ok) {
          const unavailable = response.status === 404 || response.status === 401;
          if (unavailable && !disposed && sequence.current === number) setReport(null);
          throw new Error(unavailable ? "分享链接无效或已停用，请联系站长获取新链接。" : "暂时无法刷新数据，请稍后重试。");
        }
        const result = await response.json() as SharedReport;
        if (!disposed && sequence.current === number) { setReport(result); setError(""); }
      } catch (reason) {
        if (!disposed && sequence.current === number) setError((reason as Error).name === "AbortError" ? "本次刷新超时，稍后会自动重试。" : (reason as Error).message);
      } finally {
        window.clearTimeout(timeout);
        if (!disposed && sequence.current === number) setBusy(false);
      }
    };
    void refresh();
    const visibleRefresh = () => { if (document.visibilityState === "visible") void refresh(); };
    const interval = window.setInterval(visibleRefresh, 30000);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => { disposed = true; sequence.current++; controller?.abort(); window.clearInterval(interval); document.removeEventListener("visibilitychange", visibleRefresh); };
  }, [token, offset, onlyRedeemed, revision]);
  async function copyInvite() {
    if (!report) return;
    try { await navigator.clipboard.writeText(`${window.location.origin}/?invite=${report.inviter.referralCode}`); setCopied(true); }
    catch { setCopied(false); }
  }
  return <main className={styles.page}>
    <header className={styles.header}><a href="/">译洋 · 莎试笔雅</a><span>推广成果</span></header>
    <section className={styles.intro}>
      <p className={styles.eyebrow}>专属推广记录</p>
      <h1>{report ? `${report.inviter.name}的推广成果` : "我的推广成果"}</h1>
      <p>注册与会员转化，两站统一统计。</p>
      {report && <div className={styles.invitation}><span>邀请码 <strong>{report.inviter.referralCode}</strong></span><button type="button" onClick={() => void copyInvite()}>{copied ? "邀请链接已复制" : "复制邀请链接"}</button></div>}
    </section>
    {token === "" && <div className={styles.notice} role="alert">请使用站长提供的完整专属链接打开此页面。</div>}
    {error && <div className={styles.notice} role="alert">{error}{report && " 当前显示上次成功获取的数据。"}</div>}
    {token === null || (busy && !report) ? <p role="status" className={styles.loading}>正在载入推广记录…</p> : null}
    {report && <>
      <section className={styles.stats} aria-label="推广汇总">
        <article><span>受邀注册账号</span><strong>{report.summary.registeredUsers}</strong><small>通过你的邀请码注册</small></article>
        <article><span>会员转化账号</span><strong>{report.summary.saleRedeemedUsers}</strong><small>已成功兑换售卖卡</small></article>
        <article><span>售卖卡兑换次数</span><strong>{report.summary.saleRedeemedCards}</strong><small>含首次兑换与后续续费</small></article>
      </section>
      <section className={styles.records}>
        <div className={styles.toolbar}><h2>受邀账号记录</h2><div>
          <label className={styles.filter}>显示<select value={String(onlyRedeemed)} onChange={event => { setOnlyRedeemed(event.target.value === "true"); setOffset(0); setReport(null); }}>
            <option value="false">全部账号</option><option value="true">已兑换售卖卡</option>
          </select></label>
          <button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>{busy ? "刷新中…" : "刷新"}</button>
        </div></div>
        <p className={styles.updated} role="status">更新于 {time(report.updatedAt)} · 页面显示时每 30 秒自动刷新</p>
        <div className={styles.tableScroll} tabIndex={0} aria-label="推广账号表格，可横向滚动"><table>
          <thead><tr><th>账号</th><th>注册时间</th><th>会员转化</th><th>最近兑换</th></tr></thead>
          <tbody>{report.users.map((value, index) => <tr key={`${offset}-${index}`}><td><strong>{value.name}</strong><small>{value.email}</small></td><td>{time(value.registeredAt)}</td><td>{value.saleRedeemedCards ? `${value.saleRedeemedCards} 张 · ${value.saleRedeemedDays} 天` : "尚未兑换"}</td><td>{value.lastRedemptionAt ? time(value.lastRedemptionAt) : "—"}</td></tr>)}</tbody>
        </table></div>
        {!report.users.length && <p className={styles.empty}>暂无符合条件的账号。分享你的邀请链接后，注册记录会出现在这里。</p>}
        <div className={styles.pagination}><button type="button" disabled={busy || offset === 0} onClick={() => { setOffset(value => Math.max(0, value - 50)); setReport(null); }}>上一页</button><span>{report.pagination.total ? `${offset + 1}—${offset + report.users.length} / ${report.pagination.total}` : "0 条记录"}</span><button type="button" disabled={busy || !report.pagination.hasMore} onClick={() => { setOffset(value => value + 50); setReport(null); }}>下一页</button></div>
      </section>
      <aside className={styles.notes}><p>会员转化以“售卖卡成功兑换”为依据。云猫已付款但尚未兑换的订单暂不会计入；赠送卡与点击购买均不计入。本页不统计实收金额。</p><p>此链接仅可查看你的推广记录，账号邮箱已脱敏。请妥善保存专属链接。</p></aside>
    </>}
    <footer className={styles.footer}>译洋 · 莎试笔雅 <span>共同记录每一次成长</span></footer>
  </main>;
}
