export type MaterialKind = "writing" | "translation" | "culture";
export type MaterialBlock =
  | { type: "heading"; text: string; level: number; id: string }
  | { type: "paragraph" | "quote"; text: string }
  | { type: "list"; items: string[]; ordered: boolean; start: number }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "rule" };
export type MaterialChapter = { id: string; title: string; blocks: MaterialBlock[] };
export type MaterialBook = { title: string; introduction: string; chapters: MaterialChapter[] };

export const materialBooks = {
  writing: { label: "写作手册", title: "四六级写作手册", file: "/materials/cet-writing-20261031.txt" },
  translation: { label: "翻译手册", title: "四六级翻译手册", file: "/materials/cet-translation-20261031.txt" },
  culture: { label: "中国文化词汇", title: "中国文化翻译补充资料", file: "/materials/chinese-culture-translation-20261103.txt" },
} as const;

// Only the Markdown constructs present in the supplied handbooks are accepted.
// Content is rendered as React text, never as HTML or executable markup.
export function tableCells(line: string) {
  const source = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let value = "", code = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "\\" && source[i + 1] === "|") { value += "|"; i++; continue; }
    if (char === "`") code = !code;
    if (char === "|" && !code) { cells.push(value.trim()); value = ""; }
    else value += char;
  }
  cells.push(value.trim());
  return cells;
}
const divider = (line: string) => line.trim().startsWith("|") && tableCells(line).every(cell => /^:?-{3,}:?$/.test(cell));
const listLine = (line: string) => line.match(/^\s*(?:(\d+)\.\s+|[-+*]\s+)(.*)$/);

export function parseMaterialBlocks(markdown: string, prefix: string): MaterialBlock[] {
  const lines = markdown.split("\n"), blocks: MaterialBlock[] = [];
  let i = 0;
  const special = (index: number) => /^(?:#{3,6}\s|>\s?|---\s*$)/.test(lines[index]) || !!listLine(lines[index]) || (lines[index].trim().startsWith("|") && divider(lines[index + 1] || ""));
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const heading = line.match(/^(#{3,6})\s+(.+)$/);
    if (heading) { blocks.push({ type: "heading", level: heading[1].length, text: heading[2], id: `${prefix}-section-${blocks.length}` }); i++; continue; }
    if (/^---\s*$/.test(line)) { blocks.push({ type: "rule" }); i++; continue; }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) quote.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push({ type: "quote", text: quote.join("\n") }); continue;
    }
    if (line.trim().startsWith("|") && divider(lines[i + 1] || "")) {
      const headers = tableCells(line), rows: string[][] = []; i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(tableCells(lines[i++]));
      blocks.push({ type: "table", headers, rows }); continue;
    }
    const item = listLine(line);
    if (item) {
      const ordered = !!item[1], items: string[] = [], start = Number(item[1] || 1);
      while (i < lines.length) {
        const next = listLine(lines[i]);
        if (!next || !!next[1] !== ordered) break;
        items.push(next[2]); i++;
      }
      blocks.push({ type: "list", items, ordered, start }); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !special(i)) paragraph.push(lines[i++]);
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

export function parseMaterial(markdown: string, kind: MaterialKind): MaterialBook {
  const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const title = text.match(/^# (.+)$/m)?.[1] || materialBooks[kind].title;
  const parts = [...text.matchAll(/^## (.+)$/gm)];
  const introduction = text.slice(0, parts[0]?.index ?? text.length).split("\n").filter(line => line.trim() && !/^(#|\*\*|---)/.test(line)).join(" ");
  const chapters = parts.map((part, index) => {
    const id = `${kind}-chapter-${index + 1}`;
    return { id, title: part[1], blocks: parseMaterialBlocks(text.slice(part.index! + part[0].length, parts[index + 1]?.index ?? text.length), id) };
  });
  if (!chapters.length) throw new Error("手册内容暂时不可用，请稍后重试。");
  return { title, introduction, chapters };
}

export function plainMaterialText(text: string) { return text.replace(/[*`]/g, "").replace(/\s+/g, " ").trim(); }
export function blockText(block: MaterialBlock): string {
  if (block.type === "rule") return "";
  if (block.type === "table") return [block.headers, ...block.rows].map(row => row.join(" ")).join(" ");
  if (block.type === "list") return block.items.join(" ");
  return block.text;
}
export type MaterialMatch = { chapterId: string; chapterTitle: string; sectionId?: string; title: string; excerpt: string };
export function searchMaterial(book: MaterialBook, query: string): MaterialMatch[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const results: MaterialMatch[] = [];
  for (const chapter of book.chapters) {
    let title = chapter.title, sectionId: string | undefined, texts: string[] = [];
    function flush() {
      const text = plainMaterialText([chapter.title, title, ...texts].join(" "));
      if (!words.every(word => text.toLocaleLowerCase().includes(word))) return;
      const body = plainMaterialText(texts.join(" ")) || title;
      const found = body.toLocaleLowerCase().indexOf(words[0]), start = Math.max(0, found - 34);
      results.push({ chapterId: chapter.id, chapterTitle: chapter.title, sectionId, title, excerpt: `${start ? "…" : ""}${body.slice(start, start + 160)}${body.length > start + 160 ? "…" : ""}` });
    }
    for (const block of chapter.blocks) {
      if (block.type === "heading") { flush(); title = block.text; sectionId = block.id; texts = []; }
      else texts.push(blockText(block));
    }
    flush();
  }
  return results;
}
