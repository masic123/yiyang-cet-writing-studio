import type { Question, WritingOutline } from "./types";
export function outlineGuide(q: Pick<Question, "task">) {
  const translation = q.task === "translation";
  return {
    analysis: translation ? "原文有哪些信息和关系" : "题目要我完成什么",
    analysisHint: translation
      ? "标出人物、动作、时间、数字、限定与因果关系。"
      : "话题、身份、对象和必须回应的要点。",
    position: translation ? "难点词与句子主干" : "我的核心回答",
    positionHint: translation
      ? "先确定主语、谓语，记下容易误译的搭配。"
      : "用一句话写下观点、建议或写信目的。",
    paragraph: translation ? "意群" : "内容段",
    point: translation ? "中文要表达的意思" : "本段中心",
    pointHint: translation ? "可以按句子或意义单元拆分。" : "这一段说清什么？",
    support: translation ? "英文表达思路" : "解释、例子或做法",
    supportHint: translation
      ? "不必逐字照译，先把意思表达准确。"
      : "为什么成立？用什么例子或行动支撑？",
    ending: translation ? "数字、限定和遗漏复查" : "收尾与任务复查",
    endingHint: translation
      ? "检查大多数、可能、除非等限定是否保留。"
      : "是否回答所有要求？词数与语气是否合适？",
    note: translation
      ? "先划意群，再组织英文，不按意群数量算分。"
      : "段数按任务调整，让理由支持观点。",
  };
}
export const blankOutline = (): WritingOutline => ({
  analysis: "",
  position: "",
  paragraphs: [
    { id: "body-1", point: "", support: "" },
    { id: "body-2", point: "", support: "" },
  ],
  ending: "",
});
export const hasOutline = (p?: WritingOutline) =>
  !!p &&
  !!(
    p.analysis.trim() ||
    p.position.trim() ||
    p.ending.trim() ||
    p.paragraphs.some((v) => v.point.trim() || v.support.trim())
  );
export function outlineText(p: WritingOutline, q: Pick<Question, "task">) {
  const g = outlineGuide(q);
  return `${g.analysis}\n${p.analysis}\n\n${g.position}\n${p.position}\n\n${p.paragraphs.map((v, i) => `${g.paragraph} ${i + 1}\n${g.point}：${v.point}\n${g.support}：${v.support}`).join("\n\n")}\n\n${g.ending}\n${p.ending}`;
}
