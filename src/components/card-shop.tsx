"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Copy, Crown, Receipt, SpinnerGap } from "@phosphor-icons/react";
import { api, AuthDialog } from "./ui";
import type { User } from "@/lib/types";
import styles from "./card-shop.module.css";

type Order = { id: string; plan: string; days: number; amountFen: number; status: "pending" | "fulfilled"; createdAt: number; expiresAt: number; paidAt: number | null; delivery: { code?: string; deliveredAt: number; redeemedAt: number | null; revoked: boolean } | null };
type Shop = { plans: { id: string; name: string; days: number; amountFen: number; dailyPrice: string }[]; open: boolean; launchAt: number; launchPending: boolean; launchDeferred: boolean; user: User | null; admin: boolean };
type Admin = { ready: boolean; paymentConfigured: boolean; environment: string; vaultConfigured: boolean; open: boolean; totals: { orders: number; delivered: number; revenueFen: number }; orders: (Order & { email: string; name: string })[] };
const yuan = (fen: number) => (fen / 100).toFixed(2).replace(/0$/, "");
const date = (time: number) => new Date(time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const orderStatus = (order: Order) => order.delivery?.revoked ? "已停用" : order.delivery?.redeemedAt ? "已兑换" : order.status === "fulfilled" ? "已发货" : order.expiresAt <= Date.now() ? "已超时" : "待支付";
const deferredNotice = "订阅制上线时间推迟，具体时间另行通知。当前免费批改沿用现有规则。";

export default function CardShop() {
  const [shop, setShop] = useState<Shop | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [tab, setTab] = useState("plans");
  const [login, setLogin] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState("");
  const serial = useRef(0), owner = useRef<string | null>(null);
  const requestKey = useRef<{ plan: string; key: string } | null>(null);
  const launchBlocked = !shop || shop.launchDeferred || shop.launchPending || shop.launchAt > Date.now();
  const canBuy = !!shop?.open && !launchBlocked;
  const launchNotice = shop?.launchDeferred ? deferredNotice
    : shop?.launchPending && shop.launchAt > 0 ? `会员计划于北京时间 ${date(shop.launchAt)} 上线，当前尚未开售。`
    : shop?.launchPending ? "会员商店尚未开售，开放时间另行通知。当前免费批改沿用现有规则。"
    : "会员商店暂未开售，开放后可在这里购买。";
  const refresh = useCallback(async () => {
    const number = ++serial.current;
    try {
      const data = await api<Shop>("/api/shop");
      if (serial.current !== number) return;
      if (owner.current !== (data.user?.id || null)) { setOrders([]); setAdmin(null); requestKey.current = null; setMessage(""); setBusy(""); }
      owner.current = data.user?.id || null;
      setShop(data);
      if (data.user) {
        const result = await api<{ orders: Order[] }>("/api/shop/orders");
        if (serial.current !== number) return;
        setOrders(result.orders);
      } else setOrders([]);
      if (data.admin) {
        const result = await api<Admin>("/api/shop/admin");
        if (serial.current === number) setAdmin(result);
      } else setAdmin(null);
    } catch (e) { if (serial.current === number) setError((e as Error).message); }
  }, []);
  useEffect(() => {
    void refresh();
    if (/^YY[A-F0-9]{32}$/.test(new URLSearchParams(window.location.search).get("order") || "")) setTab("orders");
    const resume = () => { if (document.visibilityState !== "hidden") void refresh(); };
    window.addEventListener("focus", resume); document.addEventListener("visibilitychange", resume);
    const expired = () => { serial.current++; owner.current = null; setShop(null); setOrders([]); setAdmin(null); setLogin(true); };
    window.addEventListener("cet:session-expired", expired);
    return () => { serial.current++; window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume); window.removeEventListener("cet:session-expired", expired); };
  }, [refresh]);
  useEffect(() => {
    if (!orders.some(o => o.status === "pending" && o.expiresAt > Date.now())) return;
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
    return () => clearInterval(timer);
  }, [orders, refresh]);
  async function action(key: string, operation: () => Promise<void>) {
    if (busy) return;
    const id = owner.current;
    setBusy(key); setError(""); setMessage("");
    try { await operation(); }
    catch (e) { if (owner.current === id) setError((e as Error).message); }
    finally { if (owner.current === id) setBusy(""); }
  }
  async function pay(order: Order) {
    if (!canBuy) throw new Error(shop?.launchDeferred ? deferredNotice : "会员商店暂未开放支付，请稍后重试。");
    const id = owner.current;
    const result = await api<Order & { checkoutUrl?: string }>(`/api/shop/orders/${order.id}/checkout`, { method: "POST", body: JSON.stringify({ mobile: /Android|iPhone|iPad/i.test(navigator.userAgent) }) });
    if (owner.current !== id) return;
    if (result.checkoutUrl) {
      const url = new URL(result.checkoutUrl);
      if (url.protocol !== "https:" || url.hostname !== "openapi.alipay.com" || url.pathname !== "/gateway.do" || url.username || url.password || url.port) throw new Error("支付地址异常，请联系管理员。");
      requestKey.current = null;
      window.location.assign(url.href);
    } else await refresh();
  }
  function buy(plan: string) {
    if (!canBuy) { setError(shop?.launchDeferred ? deferredNotice : "会员商店暂未开售，请稍后重试。"); return; }
    if (!shop?.user) { setLogin(true); return; }
    void action(plan, async () => {
      const id = owner.current;
      if (requestKey.current?.plan !== plan) requestKey.current = { plan, key: crypto.randomUUID() };
      const order = await api<Order>("/api/shop/orders", { method: "POST", body: JSON.stringify({ plan, requestKey: requestKey.current.key }) });
      if (owner.current !== id) return;
      setTab("orders"); await refresh(); await pay(order);
    });
  }
  const filtered = admin?.orders.filter(order => `${order.id} ${order.email} ${order.name}`.toLowerCase().includes(filter.toLowerCase())) || [];
  return <main className={styles.page}>
    <header className={styles.header}>
      <a href="/" className={styles.brand}><img src="/apple-touch-icon-v20261029.png" width={36} height={36} alt="" /><strong>译洋</strong><span>会员商店</span></a>
      <a href="/" className={styles.back}><ArrowLeft size={16} />返回练习</a>
    </header>
    <div className={styles.content}>
      <div className={styles.title}><div><p>译洋 × 莎试笔雅</p><h1>让每次练习，都有反馈。</h1></div><div className={styles.identity}>{shop?.user ? <><span>{shop.user.name}</span><small>{shop.user.email}</small></> : <button className="button secondary" onClick={() => setLogin(true)}>登录账号 <ArrowRight size={16} /></button>}</div></div>
      <nav className={styles.tabs} aria-label="会员商店"><button aria-current={tab === "plans" ? "page" : undefined} onClick={() => setTab("plans")}><Crown size={18} />会员卡</button><button aria-current={tab === "orders" ? "page" : undefined} onClick={() => setTab("orders")}><Receipt size={18} />我的订单</button>{shop?.admin && <button aria-current={tab === "admin" ? "page" : undefined} onClick={() => setTab("admin")}>商店管理</button>}</nav>
      {shop && (shop.launchDeferred || shop.launchPending || !shop.open) && <p className={styles.notice} role="status">{launchNotice}</p>}
      {error && <p className="error-box" role="alert">{error}<button className="text-button" onClick={() => { setError(""); void refresh(); }}>重试</button></p>}
      {message && <p className={styles.message} role="status"><Check size={18} />{message}</p>}
      {!shop && !error && <p role="status"><SpinnerGap className="spin" />正在载入…</p>}
      {tab === "plans" && shop && <>
        <div className={styles.plans}>{shop.plans.map(plan => <article className={styles.plan} key={plan.id}>
          <div className={styles.planTop}><h2>{plan.name}</h2><span>{plan.days} 天有效期</span></div>
          <p className={styles.price}><span>¥</span><b>{yuan(plan.amountFen)}</b><small>/ {plan.days} 天</small></p>
          <p className={styles.daily}>日均约 ¥{plan.dailyPrice}</p>
          <button className="button primary" disabled={!canBuy || !!busy} onClick={() => buy(plan.id)}>{busy === plan.id ? <SpinnerGap className="spin" /> : null}{canBuy ? "购买" + plan.name : "尚未开售"}{canBuy && <ArrowRight size={17} />}</button>
          <small className={styles.oneTime}>单次购买，到期不自动扣费</small>
        </article>)}</div>
        <section className={styles.benefits}><h2>一份会员，两站通用</h2><div>
          <p><Check size={18} /><span><strong>写作、翻译批改不限次数</strong><small>雅思 Task 1 / Task 2；四级、六级写作与翻译。</small></span></p>
          <p><Check size={18} /><span><strong>完整批改报告</strong><small>评分理由、逐句修改、表达建议与翻译原意核对。</small></span></p>
          <p><Check size={18} /><span><strong>兑换成功后起算</strong><small>支付确认后自动发码，在任一网站兑换后开始计时。</small></span></p>
          <p><Check size={18} /><span><strong>续费时长累加</strong><small>未到期兑换新卡，时长接续现有有效期。</small></span></p>
        </div></section>
        <p className={styles.footnote}>兑换码保存在“我的订单”。使用同一邮箱登录两站，共用会员时长。问题反馈：官方 QQ 群 1059633594。</p>
      </>}
      {tab === "orders" && <section aria-label="我的订单" className={styles.orders}>
        <div className={styles.sectionTitle}><h2>我的订单</h2><button className="text-button" disabled={!!busy} onClick={() => { setError(""); void refresh(); }}>刷新</button></div>
        {!shop?.user ? <div className={styles.empty}><Receipt size={32} /><h3>登录后查看订单和兑换码</h3><button className="button primary" onClick={() => setLogin(true)}>登录账号</button></div> : !orders.length ? <div className={styles.empty}><Receipt size={32} /><h3>还没有订单</h3><button className="button secondary" onClick={() => setTab("plans")}>查看会员卡</button></div> : orders.map(order => <article key={order.id} className={styles.order}>
          <div className={styles.orderHeading}><strong>{order.days === 7 ? "周卡" : "月卡"} · {order.days} 天</strong><span data-paid={order.status === "fulfilled"}>{orderStatus(order)}</span><b>¥{yuan(order.amountFen)}</b></div>
          <p className={styles.orderMeta}>{date(order.createdAt)}<code>{order.id}</code></p>
          {order.delivery?.code && !order.delivery.revoked && <div className={styles.delivery}><label>会员兑换码</label><code>{order.delivery.code}</code><div><button className="button secondary" onClick={() => void action("copy:" + order.id, async () => { await navigator.clipboard.writeText(order.delivery!.code!); setMessage("兑换码已复制。"); })}><Copy size={16} />复制</button>{!order.delivery.redeemedAt && <button className="button primary" disabled={!!busy || launchBlocked} onClick={() => void action("redeem:" + order.id, async () => { if (launchBlocked) throw new Error(shop.launchDeferred ? deferredNotice : "会员兑换尚未开放，请稍后重试。"); await api("/api/membership/redeem", { method: "POST", body: JSON.stringify({ code: order.delivery!.code }) }); setMessage("兑换成功，会员时长已增加。"); await refresh(); })}>立即兑换</button>}</div></div>}
          {order.status === "pending" && <div className={styles.orderActions}>{order.expiresAt > Date.now() && <button className="button primary" disabled={!!busy || !canBuy} onClick={() => void action(order.id, () => pay(order))}>继续支付</button>}<button className="button secondary" disabled={!!busy} onClick={() => void action("sync:" + order.id, async () => { await api(`/api/shop/orders/${order.id}/sync`, { method: "POST", body: "{}" }); await refresh(); setMessage("支付状态已核对；到账确认后会在此显示兑换码。"); })}>核对支付状态</button></div>}
        </article>)}
      </section>}
      {tab === "admin" && shop?.admin && admin && <section className={styles.admin} aria-label="售码管理">
        <div className={styles.sectionTitle}><h2>商店管理</h2><button className="text-button" onClick={() => void refresh()}>刷新</button></div>
        <div className={styles.metrics}><div><span>订单数</span><b>{admin.totals.orders}</b></div><div><span>已发货</span><b>{admin.totals.delivered}</b></div><div><span>已确认收款</span><b>¥{yuan(admin.totals.revenueFen)}</b></div></div>
        <div className={styles.setup}><div><strong>{admin.open ? "商店已开售" : "商店未开售"}</strong><p>支付宝：{admin.paymentConfigured ? admin.environment === "live" ? "正式配置已加载" : "沙箱，不能正式售卖" : "尚未配置"} · 卡密加密：{admin.vaultConfigured ? "已配置" : "尚未配置"}</p><p>正式商户接口、服务端配置和上线时间均满足后，才能开售。支付密钥由服务器保管。</p></div><button className="button secondary" disabled={!!busy || (!admin.open && (!admin.ready || launchBlocked))} onClick={() => void action("open", async () => { if (!admin.open && launchBlocked) throw new Error(shop.launchDeferred ? deferredNotice : "会员商店尚未到开放时间。"); await api("/api/shop/admin/open", { method: "POST", body: JSON.stringify({ open: !admin.open }) }); await refresh(); })}>{admin.open ? "暂停开售" : "开启售卖"}</button></div>
        <label className={styles.search}>订单记录<input type="search" placeholder="搜索订单号或购买邮箱" value={filter} onChange={e => setFilter(e.target.value)} /></label>
        <div className={styles.tableWrap}><table><thead><tr><th>订单 / 购买者</th><th>卡种</th><th>实收</th><th>状态</th><th>创建时间</th></tr></thead><tbody>{filtered.map(order => <tr key={order.id}><td><code>{order.id}</code><small>{order.email}</small></td><td>{order.days === 7 ? "周卡" : "月卡"}</td><td>{order.status === "fulfilled" ? "¥" + yuan(order.amountFen) : "—"}</td><td>{orderStatus(order)}</td><td>{date(order.createdAt)}</td></tr>)}</tbody></table>{!filtered.length && <p className={styles.tableEmpty}>暂无匹配订单</p>}</div>
        <p className={styles.footnote}>显示最近 100 笔订单。已确认收款为订单总金额，未扣除支付渠道手续费。重复到账通知只发一张卡；用户可在“我的订单”找回兑换码。</p>
      </section>}
    </div>
    <footer className={styles.footer}><span>译洋 · 会员商店</span><a href="/">继续练习 <ArrowRight size={15} /></a></footer>
    <AuthDialog open={login} onOpenChange={setLogin} onSuccess={() => { setLogin(false); setBusy(""); void refresh(); }} invitationRequired={false} />
  </main>;
}
