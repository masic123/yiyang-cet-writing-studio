import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { staticAssets } from "../server/assets";
import { parseMaterial, parseMaterialBlocks, searchMaterial, tableCells, type MaterialKind } from "../src/lib/reading-material";

for (const [kind, count, tableCount] of [["writing", 15, 42], ["translation", 13, 57]] as const) {
  test(`${kind} handbook keeps every chapter, appendix and table row`, () => {
    const source = readFileSync(new URL(`../public/materials/cet-${kind}-20261031.txt`, import.meta.url), "utf8");
    const book = parseMaterial(source, kind as MaterialKind);
    assert.equal(book.chapters.length, count);
    assert.equal(book.chapters.at(-1)?.title, "最后三条建议");
    const tables = book.chapters.flatMap(chapter => chapter.blocks.filter(block => block.type === "table"));
    assert.equal(tables.length, tableCount);
    const sourceRows = source.split(/\r?\n/).filter(line => line.trim().startsWith("|")).length - tableCount * 2;
    assert.equal(tables.reduce((total, table) => total + table.rows.length, 0), sourceRows);
    for (const table of tables) assert.ok(table.rows.every(row => row.length === table.headers.length));
    const headings = book.chapters.flatMap(chapter => chapter.blocks.filter(block => block.type === "heading"));
    assert.equal(headings.length, source.split(/\r?\n/).filter(line => /^#{3,6} /.test(line)).length);
    assert.equal(new Set(headings.map(heading => heading.id)).size, headings.length);
    assert.ok(book.chapters.some(chapter => chapter.title.includes("自测")));
  });
  test(`${kind} handbook is readable through the production static asset policy`, async () => {
    const assets = staticAssets(fileURLToPath(new URL("../public", import.meta.url)));
    const response = await assets.fetch(new Request(`https://example.test/materials/cet-${kind}-20261031.txt`));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type") || "", /text\/plain.*utf-8/);
    assert.equal(await response.text(), readFileSync(new URL(`../public/materials/cet-${kind}-20261031.txt`, import.meta.url), "utf8"));
  });
}
test("bilingual search finds an expression inside a vocabulary table and its section", () => {
  const source = readFileSync(new URL("../public/materials/cet-translation-20261031.txt", import.meta.url), "utf8");
  const book = parseMaterial(source, "translation");
  const english = searchMaterial(book, "intangible cultural heritage");
  assert.ok(english.some(match => match.title.includes("民俗") && match.sectionId && match.excerpt.includes("intangible cultural heritage")));
  assert.ok(searchMaterial(book, "非物质文化遗产").length);
  assert.equal(searchMaterial(book, "NoSuchPhraseXYZ").length, 0);
  assert.equal(searchMaterial(book, " ").length, 0);
});
test("Markdown blocks retain paragraph breaks and safe literal content", () => {
  assert.deepEqual(tableCells("| 中文 | `a|b` / x\\|y | |"), ["中文", "`a|b` / x|y", ""]);
  const blocks = parseMaterialBlocks("> **译文**\n> First paragraph.\n>\n> Second paragraph.\n\n3. One\n4. Two\n\n<script>alert(1)</script>", "test");
  assert.deepEqual(blocks[0], { type: "quote", text: "**译文**\nFirst paragraph.\n\nSecond paragraph." });
  assert.deepEqual(blocks[1], { type: "list", items: ["One", "Two"], ordered: true, start: 3 });
  assert.deepEqual(blocks[2], { type: "paragraph", text: "<script>alert(1)</script>" });
});
