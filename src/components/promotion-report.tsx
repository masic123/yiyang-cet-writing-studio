"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "./ui";

type Campaign = {
  inviterId: string; name: string; email: string; referralCode: string; enabled: boolean;
  discountBps: number; registeredUsers: number; saleRedeemedUsers: number; saleRedeemedCards: number;
};
type Report = {
  campaigns: Campaign[]; selectedInviterId: string | null;
  summary: { registeredUsers: number; saleRedeemedUsers: number; saleRedeemedCards: number };
  users: { userId: string; name: string; email: string; registeredAt: string; invitedAt: number;
    saleRedeemedCards: number; saleRedeemedDays: number; firstRedemptionAt: number | null; lastRedemptionAt: number | null }[];
  pagination: { offset: number; limit: number; total: number; hasMore: boolean };
  paymentBasis: "sale-card-redemption";
};
const time = (value: string | number | null) => value === null ? "—" : new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

export default function PromotionReport({ owner }: { owner: string }) {
  const [expanded, setExpanded] = useState(false);
  const [inviter, setInviter] = useState("");
  const [onlyRedeemed, setOnlyRedeemed] = useState(false);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(() => {
    if (!expanded) return;
    const sequence = ++request.current;
    setBusy(true); setError(""); setReport(null);
    const params = new URLSearchParams({ offset: String(offset), limit: "50", onlyRedeemed: String(onlyRedeemed) });
    if (inviter) params.set("inviterId", inviter);
    void api<Report>(`/api/membership/promotions?${params}`).then(value => {
      if (request.current === sequence) setReport(value);
    }).catch(reason => {
      if (request.current === sequence) setError((reason as Error).message);
    }).finally(() => { if (request.current === sequence) setBusy(false); });
    return () => { request.current++; };
  }, [owner, expanded, inviter, onlyRedeemed, offset, revision]);
  const selected = report?.campaigns.find(value => value.inviterId === report.selectedInviterId);
  return <details className="member-admin member-promotion-report" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>博主推广统计</summary>
    {expanded && <>
      <p className="small muted">按注册时绑定的邀请码归属统计，两站共用。售卖卡已兑换与实际付款分开核算；未兑换订单请在云猫核对。赠送卡和点击购买不计入兑换人数。</p>
      <div className="member-admin-fields">
        <label>推广账号<select value={inviter || report?.selectedInviterId || ""} disabled={busy} onChange={event => { setInviter(event.target.value); setOffset(0); }}>
          {!report?.campaigns.length && <option value="">{busy ? "载入中…" : "暂无推广活动"}</option>}
          {report?.campaigns.map(value => <option key={value.inviterId} value={value.inviterId}>{value.name} · {value.email}</option>)}
        </select></label>
        <label>名单范围<select value={String(onlyRedeemed)} disabled={busy} onChange={event => { setOnlyRedeemed(event.target.value === "true"); setOffset(0); }}>
          <option value="false">全部受邀账号</option><option value="true">已兑换售卖卡的账号</option>
        </select></label>
        <button type="button" className="button secondary" disabled={busy} onClick={() => setRevision(value => value + 1)}>刷新统计</button>
      </div>
      {busy && <p role="status">正在载入推广记录…</p>}
      {error && <p className="error-box" role="alert">{error}</p>}
      {report && <>
        {selected && <p className="small">邀请码 <code>{selected.referralCode}</code> · {selected.discountBps / 1000} 折 · {selected.enabled ? "活动有效" : "活动已暂停"}</p>}
        <div className="promotion-totals" aria-label="推广统计汇总">
          <span>注册账号 <b>{report.summary.registeredUsers}</b></span>
          <span>已兑换售卖卡的账号 <b>{report.summary.saleRedeemedUsers}</b></span>
          <span>已兑换售卖卡 <b>{report.summary.saleRedeemedCards}</b> 张</span>
        </div>
        <div className="promotion-table-scroll" tabIndex={0} aria-label="受邀账号明细，可横向滚动">
          <table className="promotion-table"><thead><tr><th>受邀账号</th><th>注册时间</th><th>售卖卡兑换</th><th>最近兑换</th></tr></thead>
            <tbody>{report.users.map(value => <tr key={value.userId}>
              <td><strong>{value.name}</strong><small>{value.email}</small></td>
              <td>{time(value.registeredAt)}</td>
              <td>{value.saleRedeemedCards ? `${value.saleRedeemedCards} 张 · ${value.saleRedeemedDays} 天` : "尚未兑换"}</td>
              <td>{time(value.lastRedemptionAt)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {!report.users.length && <p className="small muted">这个范围内暂无记录。</p>}
        <div className="promotion-pagination">
          <button type="button" className="button secondary" disabled={busy || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 50))}>上一页</button>
          <span className="small">{report.pagination.total ? `${offset + 1}—${offset + report.users.length} / ${report.pagination.total}` : "0 条记录"}</span>
          <button type="button" className="button secondary" disabled={busy || !report.pagination.hasMore} onClick={() => setOffset(value => value + 50)}>下一页</button>
        </div>
      </>}
    </>}
  </details>;
}
