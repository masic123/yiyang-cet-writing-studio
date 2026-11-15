"""Reproducible import of attributed CET paper snapshots, without answer content."""
import concurrent.futures
from collections import Counter, defaultdict
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT.parent / "四六级写译资料核验" / "third-party"
VOID = {"img", "br", "input", "meta", "link", "hr", "source", "wbr", "area", "base", "embed", "param", "track", "col"}


class PaperParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.parts = defaultdict(list)
        self.images = []

    def inside(self, ident):
        return any(attrs.get("id") == ident for _, attrs in self.stack)

    def handle_starttag(self, tag, pairs):
        attrs = dict(pairs)
        if tag == "img" and self.inside("paper"):
            self.images.append({"src": attrs.get("src", ""), "alt": attrs.get("alt", "")})
        if tag == "br":
            for ident in ["directions", "stem"]:
                if self.inside(ident):
                    self.parts[ident].append("\n")
        if tag not in VOID:
            self.stack.append((tag, attrs))

    def handle_endtag(self, tag):
        for i in range(len(self.stack)-1, -1, -1):
            if self.stack[i][0] == tag:
                if tag in {"p", "div", "li", "tr"}:
                    for ident in ["directions", "stem"]:
                        if self.inside(ident):
                            self.parts[ident].append("\n")
                del self.stack[i:]
                break

    def handle_data(self, text):
        if not self.inside("paper") or any(t in {"script", "style"} for t, _ in self.stack):
            return
        for ident in ["directions", "stem"]:
            if self.inside(ident):
                self.parts[ident].append(text)

    def text(self, ident):
        return re.sub(r"\s+", " ", "".join(self.parts[ident])).strip()


def category(text):
    low = text.lower()
    if re.search(r"\b(picture|cartoon|drawing)\b", low): return "图画评论"
    if re.search(r"\b(chart|graph|table)\b", low): return "图表作文"
    if re.search(r"\bletter\b", low): return "书信"
    if re.search(r"\b(proposal|propose|suggestions)\b", low): return "建议与提议"
    if re.search(r"\bsaying\b", low): return "谚语评论"
    if re.search(r"\b(advertisement|poster)\b", low): return "应用写作"
    return "议论说明"


def fetch_image(item):
    url, path = item
    if path.exists() and path.stat().st_size:
        return {"url": url, "file": str(path.relative_to(ROOT)), "status": "cached"}
    try:
        with urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=25) as response:
            data = response.read(8_000_001)
        if len(data) > 8_000_000 or not data: raise ValueError("image size")
        path.write_bytes(data)
        return {"url": url, "file": str(path.relative_to(ROOT)), "status": "downloaded"}
    except Exception as exc:
        return {"url": url, "file": str(path.relative_to(ROOT)), "status": "failed", "error": type(exc).__name__}


def main():
    records = json.loads((SOURCE / "modern-page-downloads.json").read_text(encoding="utf-8"))["records"]
    result, images, concerns = [], [], []
    image_root = ROOT / "public" / "questions"
    image_root.mkdir(parents=True, exist_ok=True)
    for r in records:
        level = 4 if r["exam_level"] == "cet4" else 6
        session, set_number, task = r["session"], int(r["set"]), r["task_type"]
        key = f"cet{level}-{session}-{set_number}-{task}"
        path = SOURCE / "modern-pages" / (key + ".html")
        parser = PaperParser()
        parser.feed(path.read_text(encoding="utf-8"))
        directions, source = parser.text("directions"), parser.text("stem")
        directions = re.sub(r"^Directions\s*[:：]?\s*", "Directions: ", directions, flags=re.I)
        if not directions or not directions.startswith("Directions:"):
            raise ValueError(f"Missing Directions: {key}")
        if task == "translation" and not re.search(r"[\u4e00-\u9fff]", source):
            raise ValueError(f"Missing Chinese source: {key}")
        word_limit = None
        if task == "writing":
            match = re.search(r"at\s+least\s+(\d+)\s+words.*?(?:no\s+more\s+than|not\s+more\s+than)\s+(\d+)\s+words", directions, re.I)
            if match:
                word_limit = {"min": int(match[1]), "max": int(match[2])}
            else:
                word_limit = {"min": 120 if level == 4 else 150, "max": 180 if level == 4 else 200}
                concerns.append({"id": key, "issue": "word_limit_defaulted", "directions": directions})
        question_images = []
        for i, img in enumerate(parser.images):
            url = urljoin(r["source_url"], img["src"])
            extension = Path(urlparse(url).path).suffix.lower()
            if extension not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
                concerns.append({"id": key, "issue": "unsupported_image", "url": url})
                continue
            name = f"{key}-{i+1}{extension}"
            images.append((url, image_root / name))
            question_images.append("/questions/" + name)
        visual = task == "writing" and (bool(parser.images) or bool(re.search(r"\b(picture|chart|cartoon|graph|table|drawing|photo|image)\b", directions, re.I)))
        if visual:
            concerns.append({"id": key, "issue": "visual_meaning_not_verified", "images": question_images})
        name = f"{session[:4]}年{int(session[5:])}月 {'四级' if level==4 else '六级'} 第{set_number}套 {'写作' if task=='writing' else '翻译'}"
        result.append({"id": int(f"{level}{session.replace('-', '')}{set_number}{1 if task=='writing' else 2}"), "name": name,
                       "examType": f"CET{level}", "task": task, "session": session, "set": set_number,
                       "category": category(directions) if task == "writing" else "段落汉译英", "topic": "",
                       "stem": directions + ("\n\n" + source if task == "writing" and source else ""),
                       "sourceText": source if task == "translation" else "", "wordLimit": word_limit, "timeLimit": 30,
                       "sourceType": "third_party_compilation", "sourceUrl": r["source_url"], "images": question_images,
                       "needsVisual": visual, "transcriptionStatus": "third_party_unverified"})
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        image_results = list(pool.map(fetch_image, images))
    failures = {"/"+i["file"].replace("\\", "/").removeprefix("public/") for i in image_results if i["status"] == "failed"}
    for q in result:
        q["images"] = [p for p in q["images"] if p not in failures]
    result.sort(key=lambda q: (-int(q["session"].replace("-", "")), q["examType"], q["set"], q["task"]))
    assert len(result) == 304 and len({q["id"] for q in result}) == 304
    assert not any(re.search("试卷原卷|全卷构成|710 分制|足迹|快速回到", q["stem"]+q["sourceText"]) for q in result)
    duplicate_groups = defaultdict(list)
    for q in result:
        duplicate_groups[(q["examType"], q["task"], q["stem"], q["sourceText"])].append(q["id"])
    duplicates = [ids for ids in duplicate_groups.values() if len(ids)>1]
    coverage = {"retrievalDate": "2026-10-28", "importedCount": len(result),
                "byLevel": dict(Counter(q["examType"] for q in result)), "byTask": dict(Counter(q["task"] for q in result)),
                "sessions": sorted({q["session"] for q in result}), "selectedScope": {"from":"2013-12", "through":"2026-06", "includesDelayedSittings":True},
                "availableScope": {"from":"2015-06", "through":"2026-06"}, "missingEarlySessions":["2013-12", "2014-06", "2014-12"],
                "visualQuestions": sum(q["needsVisual"] for q in result), "imageResults": image_results, "concerns": concerns,
                "duplicateGroups": duplicates,
                "limitations": ["第三方题面整理，未逐一对照官方原卷。", "套卷序号沿用原站，不能据此证明全部官方版本齐全。", "2013-12至2014-12尚未补齐核验。", "图意未核验的题目只给语言反馈，不给整体分。", "同题可能出现在不同套卷，保留来源身份而不合并考次。"]}
    (ROOT/"data"/"questions.json").write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    (ROOT/"data"/"coverage.json").write_text(json.dumps(coverage, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    report = f"# CET 题面导入核验\n\n已导入 {len(result)} 条记录，四级、六级各 152 条，写作、翻译各 152 条。\n\n图文题 {coverage['visualQuestions']} 条；题图 {len(image_results)} 张，下载失败 {len(failures)} 张。题图仅展示，尚未核验图意。\n\n逐页使用 HTMLParser 提取 paper 内 directions 与 stem，不引入导航、解析或参考答案。所有翻译记录都有中文原文，所有记录都有 Directions 与来源。\n\n相同题面组 {len(duplicates)} 组，保留原考次与套卷身份。记录范围 2015-06 至 2026-06，包括延考场次；2013-12、2014-06、2014-12 待补齐。\n\nCodeBuddy CLI 委派尝试因连接反复中断未产出文件，Codex 接续完成导入与核验。无 OCR 由 Codex 自行识别；PDF/图片交由 MinerU。\n\n运行：`python scripts/import-cet.py`。问题、图片与重复详情见 data/coverage.json。\n"
    (ROOT/"research"/"ingestion-report.md").write_text(report, encoding="utf-8")
    print(json.dumps({"imported": len(result), "visualQuestions": coverage["visualQuestions"], "imageCount": len(image_results), "imageFailures":len(failures), "duplicates":len(duplicates), "wordLimitFallbacks":sum(c["issue"]=="word_limit_defaulted" for c in concerns)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
