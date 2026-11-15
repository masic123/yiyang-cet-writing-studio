"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, CheckCircle, Copy, Crown, DownloadSimple, SpinnerGap } from "@phosphor-icons/react";
import { api, Modal } from "./ui";
import type { User } from "@/lib/types";
import OfficialGroup from "./official-group";
import PromotionReport from "./promotion-report";

type MemberAccount = {
  active: boolean; permanent: boolean; expiresAt: number | null; dailyRemaining: number; trialRemaining: number;
  referralCode: string; referralOfferDays: number; referralOfferPermanent: boolean; invited: number; rewardedInvites: number; admin: boolean;
  inviterPromotion?: { discountBps: number; referralCode: string } | null;
  events: { days: number; reason: string; created_at: number }[];
};
export type MembershipData = {
  enabled: boolean;
  accessEnabled: boolean;
  launchAt: number;
  launchPending: boolean;
  launchDeferred: boolean;
  plans: { id: string; price: number; originalPrice?: number; discountPrice?: number; discountBuyUrl?: string; discountBps?: number; days: number; buyUrl: string; available: boolean }[];
  promotion?: { discountBps: number; ready: boolean; couponCode?: string | null } | null;
  account: MemberAccount | null;
};
const date = (value: number) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const deferredNotice = "订阅制上线时间推迟，具体时间另行通知。当前免费批改沿用现有规则。";

export function useMembership(user: User | null, refreshKey: string) {
  const [result, setResult] = useState<{ owner: string; data: MembershipData } | null>(null);
  const [error, setError] = useState("");
  const owner = user?.id || "guest";
  const latestOwner = useRef(owner); latestOwner.current = owner;
  const requestNumber = useRef(0);
  const refresh = useCallback(async () => {
    const number = ++requestNumber.current;
    try {
      const data = await api<MembershipData>("/api/membership");
      if (latestOwner.current !== owner || requestNumber.current !== number) return;
      setResult({ owner, data }); setError("");
    } catch {
      if (latestOwner.current === owner && requestNumber.current === number) setError("会员信息暂未载入，请重试。");
    }
  }, [owner]);
  useEffect(() => {
    void refresh();
    const resume = () => { if (document.visibilityState !== "hidden") void refresh(); };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => { requestNumber.current++; window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume); };
  }, [refresh, refreshKey]);
  const data = result?.owner === owner ? result.data : null;
  useEffect(() => {
    if (!data?.launchPending) return;
    const delay = data.launchDeferred || !Number.isFinite(data.launchAt) || data.launchAt <= 0
      ? 60000
      : Math.min(60000, Math.max(1000, data.launchAt - Date.now() + 100));
    const timer = window.setTimeout(() => void refresh(), delay);
    return () => window.clearTimeout(timer);
  }, [data, refresh]);
  return { data, error, refresh };
}

export default function MembershipCenter({ open, onOpenChange, user, data, error, refresh, onLogin }: {
  open: boolean; onOpenChange: (open: boolean) => void; user: User | null;
  data: MembershipData | null; error: string; refresh: () => Promise<void>; onLogin: () => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [problem, setProblem] = useState("");
  const [cardDays, setCardDays] = useState(30);
  const [quantity, setQuantity] = useState(20);
  const [purpose, setPurpose] = useState("sale");
  const [batch, setBatch] = useState<{ batchId: string; codes: string[]; days: number; purpose: string } | null>(null);
  const owner = useRef(user?.id); owner.current = user?.id;
  useEffect(() => { if (open) void refresh(); else { setCode(""); setProblem(""); setMessage(""); setBatch(null); } }, [open, refresh]);
  useEffect(() => { setCode(""); setProblem(""); setMessage(""); setBatch(null); setBusy(false); }, [user?.id]);
  const account = data?.account;
  const launchBlocked = !data || data.launchDeferred || data.launchPending;
  const launchNotice = data?.launchDeferred ? deferredNotice
    : data?.launchPending && data.launchAt > 0 ? `会员将于北京时间 ${date(data.launchAt)} 上线。此前免费批改沿用现有规则。`
    : data?.launchPending ? "订阅制尚未上线，开放时间另行通知。当前免费批改沿用现有规则。"
    : "云猫商品审核中，审核通过后开放购买。当前免费批改沿用原有规则。";
  async function redeem(event: React.FormEvent) {
    event.preventDefault();
    if (launchBlocked) { setProblem(data?.launchDeferred ? deferredNotice : "会员兑换尚未开放，请稍后重试。"); return; }
    if (!user) { onLogin(); return; }
    if (busy) return;
    const id = user.id;
    setBusy(true); setProblem(""); setMessage("");
    try {
      const result = await api<{ alreadyRedeemed: boolean }>("/api/membership/redeem", { method: "POST", body: JSON.stringify({ code }) });
      if (owner.current !== id) return;
      setCode(""); setMessage(result.alreadyRedeemed ? "这张会员卡已兑换，无需重复兑换。" : "兑换成功，会员时长已增加。两站均可使用。");
      await refresh();
    } catch (e) { if (owner.current === id) setProblem((e as Error).message); }
    finally { if (owner.current === id) setBusy(false); }
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setMessage("已复制。"); }
    catch { setProblem("复制失败，请手动选择并复制。"); }
  }
  async function generateCards() {
    if (busy || !user || !account?.admin) return;
    const id = user.id;
    setBusy(true); setProblem(""); setBatch(null);
    try {
      const result = await api<{ batchId: string; codes: string[]; days: number; purpose: string }>("/api/membership/cards", { method: "POST", body: JSON.stringify({ quantity, days: cardDays, purpose, label: cardDays === 7 ? "云猫周卡" : "云猫月卡" }) });
      if (owner.current === id) setBatch(result);
    } catch (e) { if (owner.current === id) setProblem((e as Error).message); }
    finally { if (owner.current === id) setBusy(false); }
  }
  function downloadCards() {
    if (!batch) return;
    const url = URL.createObjectURL(new Blob([batch.codes.join("\n") + "\n"], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `云猫-${batch.purpose === "gift" ? "赠送" : "售卖"}-${batch.days}天会员卡-${batch.batchId}.txt`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <Modal open={open} onOpenChange={onOpenChange} title="会员与兑换" wide>
    <div className="membership-center">
      <a className="text-button" href="/shop" target="_blank" rel="noopener">会员商店 · 我的订单 <ArrowSquareOut size={16} /></a>
      {error && <div className="error-box" role="alert"><span>{error}</span><button type="button" className="text-button" onClick={() => void refresh()}>重试</button></div>}
      {!data && !error && <p role="status"><SpinnerGap className="spin" />正在载入会员信息…</p>}
      {data && <>
        <section className="member-status" aria-label="我的会员">
          <Crown size={25} weight={account?.active ? "fill" : "regular"} />
          <div><strong>{account?.permanent ? "永久VIP" : account?.active ? "会员有效" : account?.expiresAt ? "会员已到期" : "免费账户"}</strong>
            <p>{account?.permanent ? "两站通用 · 长期有效，无需续费" : account?.active ? `有效期至 ${date(account.expiresAt!)}` : !data.accessEnabled ? "免费批改开放中" : account ? `今日免费 ${account.dailyRemaining} 次${account.trialRemaining > 0 ? ` · 历史试用剩余 ${account.trialRemaining} 次` : ""}` : "登录后兑换会员，或使用免费批改次数"}</p>
          </div>
        </section>
        {!account?.permanent && <div className="member-plans">
          {data.plans.map(plan => <section className="member-plan" key={plan.id}>
            <h3>{plan.days === 7 ? "周卡" : "月卡"}<span>{plan.days} 天</span></h3>
            <p className="member-price"><b>¥{(plan.discountPrice ?? plan.price).toFixed(2)}</b><span>{plan.discountBps ? "专属 8.5 折" : "批改不限次数"}</span></p>
            {plan.originalPrice !== undefined && <p className="small muted">原价 <s>¥{plan.originalPrice.toFixed(2)}</s> · 购买及续费适用</p>}
            <p className="small muted">约 ¥{((plan.discountPrice ?? plan.price) / plan.days).toFixed(2)} / 天</p>
            {plan.available && !launchBlocked ? <a href={plan.discountBuyUrl || plan.buyUrl} target="_blank" rel="noopener noreferrer" className="button primary">购买{plan.days === 7 ? "周卡" : "月卡"}<ArrowSquareOut size={17} /></a> : <button type="button" className="button secondary" disabled>暂未开售</button>}
          </section>)}
        </div>}
        {data.promotion && <div className="member-invite"><p className="small muted">{data.promotion.ready ? data.promotion.couponCode ? "已识别你的专属邀请权益。复制优惠券码，在云猫购买周卡、月卡时填入并使用，购买及续费均享 8.5 折；请在付款前核对结算金额。" : "已识别你的专属邀请权益，周卡、月卡购买及续费均享 8.5 折。购买时请核对云猫结算金额。" : "你的账号已绑定专属邀请权益，8.5 折购买入口正在准备。"}</p>
          {data.promotion.ready && data.promotion.couponCode && <div><code>{data.promotion.couponCode}</code><button type="button" className="button secondary" onClick={() => void copy(data.promotion!.couponCode!)}><Copy size={16} />复制优惠券码</button></div>}
          {data.promotion.ready && !data.promotion.couponCode && <p className="small muted">专享卡仅限通过对应推广邀请码注册的账号兑换。请使用当前账号购买和兑换，勿将卡密转给不符合资格的账号。</p>}
        </div>}
        <section className="member-benefits" aria-label="会员权益">
          <h3>会员权益</h3>
          <ul>
            <li><strong>批改次数不限</strong><span>会员有效期内，写作与翻译批改不限次数。</span></li>
            <li><strong>覆盖两类考试</strong><span>雅思 Task 1、Task 2；四级、六级写作与翻译。</span></li>
            <li><strong>完整批改反馈</strong><span>评分与理由、逐句修改、表达建议；翻译核对原意与漏译。</span></li>
            <li><strong>两个网站通用</strong><span>同一邮箱登录莎试笔雅、译洋，共用会员时长。</span></li>
            <li><strong>兑换成功后起算</strong><span>购买后获得兑换码；兑换成功时开始计算 7 天或 30 天。</span></li>
            <li><strong>续费时长可累加</strong><span>未到期兑换新卡，在现有到期时间上继续增加时长。</span></li>
          </ul>
          <p className="small muted">免费次数和会员批改均提供完整报告。正式开售后，免费账户每天 1 次；新注册赠送 1 天VIP，专属邀请码按对应权益发放，不与 1 天叠加；会员有效期内不限次数。</p>
        </section>
        <p className="small muted">莎试笔雅、译洋两站通用。从兑换时起算，未到期可累加。购买后在下方填写云猫发放的兑换码。</p>
        {(data.launchDeferred || data.launchPending || !data.accessEnabled) && <p className="small muted" role="status">{launchNotice}</p>}
        {!account?.permanent && <form className="member-redeem" onSubmit={redeem}>
          <label htmlFor="member-code">会员兑换码</label>
          <div><input id="member-code" autoComplete="off" spellCheck={false} maxLength={100} placeholder="YY-…" value={code} onChange={e => setCode(e.target.value)} disabled={busy || !user || launchBlocked} required={!!user} />
            <button type={user ? "submit" : "button"} className="button primary" disabled={busy || launchBlocked || (!!user && !code.trim())} onClick={user ? undefined : onLogin}>{busy ? <SpinnerGap className="spin" size={18} /> : null}{user ? "兑换会员" : "登录后兑换"}</button></div>
        </form>}
        {message && <p className="member-message" role="status"><CheckCircle size={18} />{message}</p>}
        {problem && <p className="error-box" role="alert">{problem}</p>}
        {account && <section className="member-invite" aria-label="邀请奖励">
          <h3>{account.inviterPromotion ? "专属推广邀请码" : account.referralOfferPermanent ? "专属邀请：好友注册永久VIP" : account.referralOfferDays ? `专属邀请：好友注册获 ${account.referralOfferDays} 天VIP` : "邀请好友，获得 3 天会员"}</h3>
          {account.inviterPromotion && <p className="small muted">新用户通过下方邀请链接注册，或注册时填写此邀请码，账号会记录推广来源。专属购买权益可在受邀账号的会员中心查看，注册赠礼按网站现有规则发放。</p>}
          {account.referralOfferPermanent && <p className="small muted">新用户注册时填写下方邀请码，自动获得永久VIP，两站通用，无需续费；不叠加普通注册赠礼。</p>}
          {!account.referralOfferPermanent && account.referralOfferDays > 0 && <p className="small muted">新用户注册时填写下方邀请码，自动获得 {account.referralOfferDays} 天VIP，两站通用，每个新账号仅领取一次。正式上线前注册，赠送时长从上线时起算。</p>}
          <p className="small muted">好友注册时填写你的邀请码，首次兑换购买的付费会员卡后，赠送邀请人 3 天会员。续费、赠送卡不重复发奖{account.permanent ? "；永久VIP无需累加时长" : ""}。已邀请 {account.invited} 位，已获奖励 {account.rewardedInvites} 位。</p>
          <div><code>{account.referralCode}</code><button type="button" className="button secondary" onClick={() => void copy(account.referralCode)}><Copy size={16} />复制邀请码</button><button type="button" className="text-button" onClick={() => void copy(`${window.location.origin}/?invite=${account.referralCode}`)}>复制邀请链接</button></div>
        </section>}
        <section className="member-rules" aria-label="免费批改规则">
          <h3>{data.accessEnabled ? "免费批改规则" : "正式开售后的免费批改规则"}</h3>
          <p>新注册账号赠送 1 天VIP；专属邀请码按对应权益发放，不与 1 天叠加。正式上线前注册，VIP时长从上线时起算。非会员每天免费批改 1 次。历史账号已获试用次数保留，先用当日免费次数，再用历史剩余试用。免费次数在北京时间零点重置，两站共用，失败不扣次。</p>
        </section>
        {!!account?.events.length && <section className="member-history" aria-label="会员时长记录"><h3>最近时长记录</h3><ul>{account.events.map((event, i) => <li key={i}><span>{({ card: "会员卡兑换", invite: "邀请首购奖励", "registration-invite": "专属邀请注册赠礼", "registration-welcome": "新用户注册赠礼" } as Record<string, string>)[event.reason] || "会员奖励"}<small>{date(event.created_at)}</small></span><strong>+{event.days} 天</strong></li>)}</ul></section>}
        {account?.admin && <details className="member-admin"><summary>卡密管理</summary>
          <div className="member-admin-fields"><label>卡种<select value={cardDays} onChange={e => setCardDays(Number(e.target.value))} disabled={busy}><option value={7}>周卡 · 7 天</option><option value={30}>月卡 · 30 天</option></select></label><label>用途<select value={purpose} onChange={e => setPurpose(e.target.value)} disabled={busy}><option value="sale">云猫售卖</option><option value="gift">赠送，不触发邀请奖励</option></select></label><label>生成数量<input type="number" min={1} max={200} value={quantity} onChange={e => setQuantity(Number(e.target.value))} disabled={busy} /></label><button type="button" className="button secondary" disabled={busy || !Number.isInteger(quantity) || quantity < 1 || quantity > 200} onClick={() => void generateCards()}>生成卡密</button></div>
          {batch && <div><label htmlFor="member-cards-export">本批 {batch.codes.length} 张 · 每张 {batch.days} 天</label><textarea id="member-cards-export" readOnly rows={5} value={batch.codes.join("\n")} /><button type="button" className="button secondary" onClick={downloadCards}><DownloadSimple size={17} />下载卡密 TXT</button><p className="small muted">每行一张，导入云猫对应商品库存。请先下载保存，关闭窗口后不会再次展示完整卡密。</p></div>}
        </details>}
        {account?.admin && user && <PromotionReport key={user.id} owner={user.id} />}
        <OfficialGroup />
      </>}
    </div>
  </Modal>;
}
