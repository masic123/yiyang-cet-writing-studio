import questionData from "../../data/questions.json";
import samplesData from "../../data/official-samples.json";
import { cultureQuestions } from "./culture-translation";
import { methodAppliesTo } from "./methods";
import { officialSource } from "./resources";
import type {
  EssayInput,
  MethodRule,
  OfficialSamples,
  Question,
} from "./types";
export const questions = (): Question[] => [...questionData as Question[], ...cultureQuestions];
export const officialSamples = () => samplesData as unknown as OfficialSamples;
const rule = (
  id: string,
  title: string,
  summary: string,
  detail: string,
  task: MethodRule["task"],
  page: number,
  section: string,
  kind: MethodRule["source"]["kind"] = "practice_advice",
): MethodRule => ({
  id,
  title,
  summary,
  detail,
  task,
  source: {
    title: officialSource.title,
    page,
    section,
    kind,
    url: `${officialSource.url}#page=${page}`,
  },
});
export const methods = (): MethodRule[] => [
  rule(
    "task",
    "先完成题目要求",
    "看清身份、对象、话题和指定要点。",
    "先回答 Directions 让你做什么。评论、解释、建议、书信各有不同任务；指定开头句、图画含义与必要格式都要核对。相关话题并不等于完成任务。",
    "writing",
    8,
    "写作技能与评分标准",
    "official_summary",
  ),
  rule(
    "develop",
    "让理由真正支持观点",
    "解释为什么，补上相关例子或具体做法。",
    "每段围绕一个意思展开。六级尤其重视较为深入的讨论、解释和说明；不要重复口号或虚构调查数据。段数依据内容调整，不把三段式当成评分硬规则。",
    "writing",
    9,
    "六级写作能力要求",
  ),
  rule(
    "structure",
    "先保证句子主干完整",
    "检查主谓、从句结构和句间关系。",
    "优先处理影响理解的结构错误，再检查反复出现的时态、单复数、冠词和搭配问题。错误严重程度和重复情况比机械计数更有用，不存在通用的一错扣一分公式。",
    "all",
    15,
    "总体印象评分",
  ),
  rule(
    "words",
    "按本题 Directions 核对词数",
    "四级、六级的题面要求分别处理。",
    "四级通常要求 120-180 词，六级通常为 150-200 词，具体以本题为准。词数不足可能影响任务完成；不能杜撰每少十词固定扣分。翻译没有统一英文词数门槛。",
    "writing",
    8,
    "写作任务与词数要求",
  ),
  rule(
    "meaning",
    "先保住原文全部意思",
    "逐意群核对人物、动作、对象和信息。",
    "翻译首先要准确、完整传达原意。能读通但漏掉事实、换错主体或改错关系，仍然影响表现。允许拆句、合句与重组，接受多种忠实自然的译法。",
    "translation",
    16,
    "翻译评分标准",
    "official_summary",
  ),
  rule(
    "qualifiers",
    "单独检查限定和数字",
    "大多数、可能、否定、时间与单位都要保留。",
    "区分大多数与全部、可能与必然，保留除非、尽管、因此等逻辑关系。复查数量级、时间、比较对象和题中专名括注。意群表用于查漏，不是逐点扣分表。",
    "translation",
    16,
    "准确传达原意",
  ),
  rule(
    "natural",
    "准确的普通词也很好",
    "把搭配、语法和意思写对，再改善表达。",
    "简单且贴切的词句应保留。没有固定的高级词、倒装或被动句加分；可选的正式化、同义替换要与实际错误区分。连接词也必须符合句间真实关系。",
    "all",
    15,
    "用词贴切与语言准确",
  ),
  rule(
    "holistic",
    "先整体定档，再解释证据",
    "原始满分 15，不把诊断项加权成总分。",
    "写作与翻译采用总体印象评分。五档为 13-15、10-12、7-9、4-6、1-3，代表分 14、11、8、5、2。四、六级需要参照各自要求。单篇原始分不能乘 7.1 当作成绩单分。",
    "all",
    15,
    "评分方法",
    "official_summary",
  ),
];
export function resolveQuestion(input: EssayInput): Question {
  if (input.questionId !== null) {
    const q = questions().find((q) => q.id === input.questionId);
    if (!q) throw new Error("题目不存在，请重新选择。");
    return q;
  }
  const c = input.customQuestion;
  if (!c) throw new Error("请填写自选题目。");
  return {
    id: 0,
    name: "自选题目",
    task: c.task,
    examType: c.examType,
    stem: c.stem,
    sourceText: c.sourceText,
    session: "",
    set: 0,
    category: "自选",
    topic: "",
    wordLimit:
      c.task === "writing"
        ? {
            min: c.wordMin || (c.examType === "CET4" ? 120 : 150),
            max: c.wordMax || (c.examType === "CET4" ? 180 : 200),
          }
        : null,
    timeLimit: 30,
    sourceType: "custom",
    sourceUrl: "",
    images: [],
    needsVisual: c.needsVisual,
    transcriptionStatus: "user_provided",
  };
}
export const referencesFor = (q: Question) => ({
  rules: methods().filter((r) => methodAppliesTo(r, q)),
});
