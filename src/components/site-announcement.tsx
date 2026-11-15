"use client";
import { useEffect, useState } from "react";
import { ArrowRight } from "@phosphor-icons/react";
import { Modal } from "./ui";
import "./site-announcement.css";
const key = "cet:site-announcement:20261103-culture-supplement";
let seenThisSession = false;
export default function SiteAnnouncement({ open, onOpenChange, blocked, autoBlocked, onMaterials }: {
  open: boolean; onOpenChange: (value: boolean) => void; blocked: boolean; autoBlocked: boolean; onMaterials: () => void;
}) {
  const [autoOpen, setAutoOpen] = useState(false);
  useEffect(() => {
    let seen = seenThisSession;
    try { seen = seen || localStorage.getItem(key) === "seen"; } catch {}
    setAutoOpen(!seen);
    const seenElsewhere = (event: StorageEvent) => {
      if (event.key === key && event.newValue === "seen") { seenThisSession = true; setAutoOpen(false); }
    };
    window.addEventListener("storage", seenElsewhere);
    return () => window.removeEventListener("storage", seenElsewhere);
  }, []);
  function dismiss() {
    seenThisSession = true;
    setAutoOpen(false);
    try { localStorage.setItem(key, "seen"); } catch {}
    onOpenChange(false);
  }
  return <Modal open={(open || (autoOpen && !autoBlocked)) && !blocked} onOpenChange={value => { if (!value) dismiss(); else onOpenChange(true); }} title="中国文化翻译补充题库已上线" wide>
      <article className="developer-announcement">
        <p className="announcement-date">2026年11月4日 · 译洋更新</p>
        <p>这次为大家补充了<strong>30个中国文化主题、60道翻译练习</strong>，四级、六级各30道，覆盖节日、饮食、服饰、文学艺术、建筑与文化遗产等内容。</p>
        <p>每题配有参考译文，并加入<strong>313句逐句精翻练习</strong>，方便大家翻译后对照学习，再通过背诵、默写巩固表达。</p>
        <p>补充资料同步整理了<strong>201条主题词汇与短语条目、40组通用搭配</strong>，附用法与易错点，可以按主题查阅，也可以搜索中英文表达。</p>
        <h3>使用入口</h3>
        <ul className="announcement-entry-list">
          <li><strong>段落翻译：</strong>题库 → 中国文化补充题</li>
          <li><strong>词汇复习：</strong>补充资料 → 中国文化词汇</li>
          <li><strong>背诵默写：</strong>逐句精翻 → 中国文化补充</li>
        </ul>
        <p className="announcement-note">题目围绕廖华英《中国文化概况》的主题原创改编，用于拓展练习，不是真题或押题。安卓与 Windows 客户端已同步更新，请按提示升级。</p>
        <p>如果你觉得好用，欢迎分享给朋友。</p>
        <div className="announcement-actions">
          <button type="button" className="button primary" onClick={() => { dismiss(); onMaterials(); }}>查看中国文化词汇<ArrowRight size={16} /></button>
          <button type="button" className="button secondary" onClick={dismiss}>我知道了</button>
        </div>
      </article>
    </Modal>;
}
