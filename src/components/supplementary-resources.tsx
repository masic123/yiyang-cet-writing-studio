"use client";
import { Fragment, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, BookOpen, CaretDown, MagnifyingGlass, SpinnerGap, X } from "@phosphor-icons/react";
import { materialBooks, parseMaterial, plainMaterialText, searchMaterial, type MaterialBlock, type MaterialBook, type MaterialKind } from "@/lib/reading-material";

export type SupplementaryTab = MaterialKind;
const tabs = [{ id: "writing", label: "写作手册" }, { id: "translation", label: "翻译手册" }, { id: "culture", label: "中国文化词汇" }] as const;
const books = new Map<MaterialKind, MaterialBook>();
const locationKey = (kind: MaterialKind) => `cet:material-chapter:${kind}`;

function Inline({ text }: { text: string }) {
  const pieces = text.split(/(`[^`\n]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g);
  return <>{pieces.map((part, i) => part.startsWith("`") && part.endsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part.startsWith("*") && part.endsWith("*") ? <em key={i}>{part.slice(1, -1)}</em> : <Fragment key={i}>{part}</Fragment>)}</>;
}
function Lines({ text }: { text: string }) { return <>{text.split("\n").map((line, i) => <Fragment key={i}>{i > 0 && <br />}<Inline text={line} /></Fragment>)}</>; }
function Block({ block }: { block: MaterialBlock }) {
  if (block.type === "rule") return <hr />;
  if (block.type === "heading") return block.level === 3 ? <h3 id={block.id}><Inline text={block.text} /></h3> : <h4 id={block.id}><Inline text={block.text} /></h4>;
  if (block.type === "table") return <div className={`material-table ${block.headers.length > 2 ? "material-table-wide" : ""}`}>
    <table><thead><tr>{block.headers.map((header, i) => <th key={i} scope="col"><Inline text={header} /></th>)}</tr></thead>
      <tbody>{block.rows.map((row, i) => <tr key={i}>{block.headers.map((header, j) => <td key={j} data-label={plainMaterialText(header)}><span><Inline text={row[j] || ""} /></span></td>)}</tr>)}</tbody></table>
  </div>;
  if (block.type === "list") return block.ordered ? <ol start={block.start}>{block.items.map((item, i) => <li key={i}><Inline text={item} /></li>)}</ol> : <ul>{block.items.map((item, i) => <li key={i}><Inline text={item} /></li>)}</ul>;
  if (block.type === "quote") return <blockquote>{block.text.split(/\n\s*\n/).filter(Boolean).map((paragraph, i) => <p key={i}><Lines text={paragraph} /></p>)}</blockquote>;
  return <p><Lines text={block.text} /></p>;
}
function Highlight({ text, query }: { text: string; query: string }) {
  const term = query.trim().split(/\s+/)[0]?.toLocaleLowerCase();
  if (!term) return text;
  const nodes: ReactNode[] = []; let position = 0;
  for (let count = 0; count < 60; count++) {
    const next = text.toLocaleLowerCase().indexOf(term, position);
    if (next < 0) break;
    nodes.push(text.slice(position, next), <mark key={next}>{text.slice(next, next + term.length)}</mark>); position = next + term.length;
  }
  nodes.push(text.slice(position)); return <>{nodes}</>;
}

export default function SupplementaryResources({ tab, onTabChange }: { tab: SupplementaryTab; onTabChange: (tab: SupplementaryTab) => void }) {
  const [book, setBook] = useState<MaterialBook | null>(null), [chapterId, setChapterId] = useState("");
  const [query, setQuery] = useState(""), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  const deferredQuery = useDeferredValue(query), article = useRef<HTMLElement>(null), contents = useRef<HTMLDetailsElement>(null), tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const pendingSection = useRef<string | null>(null);
  useEffect(() => {
    const kind = tab, controller = new AbortController(); let active = true;
    setBook(null); setError(""); setQuery("");
    function load(value: MaterialBook) {
      if (!active) return;
      let remembered = ""; try { remembered = localStorage.getItem(locationKey(kind)) || ""; } catch { /* Reading works without browser storage. */ }
      setChapterId(value.chapters.some(chapter => chapter.id === remembered) ? remembered : value.chapters[0].id); setBook(value);
    }
    const cached = books.get(kind);
    if (cached) load(cached);
    else fetch(materialBooks[kind].file, { signal: controller.signal }).then(response => { if (!response.ok) throw new Error("手册暂时没有载入成功，请重试。"); return response.text(); }).then(markdown => {
      const value = parseMaterial(markdown, kind); books.set(kind, value); load(value);
    }).catch(reason => { if (active && reason.name !== "AbortError") setError(reason.message || "手册暂时没有载入成功，请重试。"); });
    return () => { active = false; controller.abort(); };
  }, [tab, retry]);
  const chapterIndex = book?.chapters.findIndex(chapter => chapter.id === chapterId) ?? -1;
  const chapter = book?.chapters[Math.max(0, chapterIndex)];
  const matches = useMemo(() => book ? searchMaterial(book, deferredQuery) : [], [book, deferredQuery]);
  useEffect(() => {
    if (!book || !chapter || !chapter.id.startsWith(`${tab}-`)) return;
    try { localStorage.setItem(locationKey(tab), chapter.id); } catch { /* Optional reading position. */ }
  }, [tab, book, chapter]);
  useEffect(() => {
    if (!pendingSection.current || query) return;
    const target = pendingSection.current; pendingSection.current = null;
    const frame = requestAnimationFrame(() => {
      (target === "chapter" ? article.current : document.getElementById(target))?.scrollIntoView({ block: "start", behavior: "instant" });
      article.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [chapterId, query]);
  function selectChapter(id: string, sectionId?: string) {
    pendingSection.current = sectionId || "chapter"; setChapterId(id); setQuery("");
    if (contents.current) contents.current.open = false;
    if (id === chapterId && !query) {
      (sectionId ? document.getElementById(sectionId) : article.current)?.scrollIntoView({ block: "start", behavior: "instant" });
      pendingSection.current = null;
    }
  }
  function tableOfContents() {
    return <nav aria-label={`${materialBooks[tab].label}章节`} className="material-chapters">{book?.chapters.map(item => <button type="button" key={item.id} aria-current={chapter?.id === item.id ? "page" : undefined} className={chapter?.id === item.id ? "active" : ""} onClick={() => selectChapter(item.id)}>{item.title}</button>)}</nav>;
  }
  return <section className="supplementary-view">
    <div className="page-intro supplementary-intro"><h1>补充资料</h1></div>
    <div className="supplementary-tabs" role="tablist" aria-label="补充资料分类">{tabs.map((item, i) => <button key={item.id} ref={element => { tabButtons.current[i] = element; }} id={`resources-tab-${item.id}`} type="button" role="tab" aria-selected={tab === item.id} aria-controls={`resources-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => onTabChange(item.id)} onKeyDown={event => {
      const target = event.key === "ArrowRight" ? (i + 1) % tabs.length : event.key === "ArrowLeft" ? (i + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
      if (target >= 0) { event.preventDefault(); onTabChange(tabs[target].id); tabButtons.current[target]?.focus(); }
    }}>{item.label}</button>)}</div>
    <div role="tabpanel" id={`resources-panel-${tab}`} aria-labelledby={`resources-tab-${tab}`}>
      <>
        <div className="material-toolbar"><div><BookOpen size={21} /><h2>{materialBooks[tab].title}</h2>{book && <span>{book.chapters.length} 个章节</span>}</div>
          <label className="material-search"><MagnifyingGlass size={18} /><span className="sr-only">搜索当前手册</span><input type="search" placeholder="搜索词汇、句式或主题" value={query} onChange={event => setQuery(event.target.value)} disabled={!book} />{query && <button type="button" aria-label="清空搜索" onClick={() => setQuery("")}><X size={16} /></button>}</label>
        </div>
        {error ? <div className="material-state" role="alert"><p>{error}</p><button type="button" className="button secondary" onClick={() => setRetry(value => value + 1)}>重新载入</button></div> : !book ? <div className="material-state" role="status"><SpinnerGap size={24} className="spin" /><p>正在载入手册…</p></div> : <>
          <details className="material-mobile-contents" ref={contents}><summary><span>章节目录</span><span>{chapter?.title}</span><CaretDown size={16} /></summary>{tableOfContents()}</details>
          <div className="material-layout"><aside className="material-contents"><h3>章节目录</h3>{tableOfContents()}</aside>
            {query.trim() ? <div className="material-results" aria-label="手册搜索结果"><p className="material-result-count" role="status">{matches.length ? `找到 ${matches.length} 处相关内容` : "没有找到相关内容，换个词试试。"}</p>{matches.map((match, i) => <button type="button" key={i} onClick={() => selectChapter(match.chapterId, match.sectionId)}><span>{match.chapterTitle}</span><strong><Highlight text={plainMaterialText(match.title)} query={deferredQuery} /></strong><p><Highlight text={match.excerpt} query={deferredQuery} /></p><ArrowRight size={18} /></button>)}</div> : chapter && <article className="material-article" ref={article} tabIndex={-1} aria-label={chapter.title}>
              <header><span>{chapterIndex + 1} / {book.chapters.length}</span><h2>{chapter.title}</h2></header>
              <div className="material-prose">{chapterIndex === 0 && book.introduction && <p className="material-book-intro">{book.introduction}</p>}{chapter.blocks.map((block, i) => <Block key={i} block={block} />)}</div>
              <nav className="material-pagination" aria-label="手册翻页"><button type="button" disabled={chapterIndex <= 0} onClick={() => selectChapter(book.chapters[chapterIndex - 1].id)}><ArrowLeft size={18} /><span><small>上一章</small>{book.chapters[chapterIndex - 1]?.title || "已是第一章"}</span></button><button type="button" disabled={chapterIndex >= book.chapters.length - 1} onClick={() => selectChapter(book.chapters[chapterIndex + 1].id)}><span><small>下一章</small>{book.chapters[chapterIndex + 1]?.title || "已是最后一章"}</span><ArrowRight size={18} /></button></nav>
            </article>}
          </div>
        </>}
      </>
    </div>
  </section>;
}
