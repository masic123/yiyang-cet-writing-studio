"use client";
import { List, SignOut, UserCircle } from "@phosphor-icons/react";
import { Modal } from "./ui";
import FriendSiteLink from "./friend-site-link";

type NavItem<T> = { id: T; label: string; icon: typeof List };
export default function MobileNavigation<T extends string>({ items, view, onNavigate, open, onOpenChange, user, onLogin, onLogout, busy }: {
  items: NavItem<T>[]; view: string; onNavigate: (view: T) => void;
  open: boolean; onOpenChange: (open: boolean) => void;
  user: { name: string } | null; onLogin: () => void; onLogout: () => void; busy: boolean;
}) {
  const core = ["writer", "bank", "teacher", "history"].map(id => items.find(item => item.id === id)).filter((item): item is NavItem<T> => !!item);
  const extra = items.filter(item => !core.includes(item));
  const selected = view === "report" ? "history" : view;
  const labels: Record<string, string> = { writer: "练习", bank: "题库", teacher: "AI 老师", history: "记录" };
  function navigate(id: T) { onOpenChange(false); onNavigate(id); }
  return <>
    <nav className="mobile-nav" aria-label="移动端导航">
      {core.map(item => <button key={item.id} type="button" aria-label={item.label} aria-current={selected === item.id ? "page" : undefined} className={selected === item.id ? "active" : ""} onClick={() => navigate(item.id)}>
        <item.icon size={21} weight={selected === item.id ? "fill" : "regular"} /><span>{labels[item.id] || item.label}</span>
      </button>)}
      <button type="button" aria-label="更多功能" aria-haspopup="dialog" aria-expanded={open} className={extra.some(item => item.id === selected) ? "active" : ""} onClick={() => onOpenChange(true)}><List size={21} /><span>更多</span></button>
    </nav>
    <Modal open={open} onOpenChange={onOpenChange} title="更多功能">
      <div className="mobile-menu-content">
        <div className="mobile-menu-links">
          {extra.map(item => <button key={item.id} type="button" aria-current={selected === item.id ? "page" : undefined} onClick={() => navigate(item.id)}><item.icon size={22} /><span>{item.label}</span></button>)}
        </div>
        <div className="mobile-menu-account">
          <UserCircle size={28} /><strong>{user?.name || "游客浏览"}</strong><span className="small muted">全员免费</span>
          {user ? <button type="button" className="text-button" disabled={busy} onClick={() => { onOpenChange(false); onLogout(); }}><SignOut size={18} />退出账号</button> : <button type="button" className="button primary" onClick={() => { onOpenChange(false); onLogin(); }}>登录 / 注册</button>}
        </div>
        <FriendSiteLink />
      </div>
    </Modal>
  </>;
}
