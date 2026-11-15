import type { Metadata } from "next";
export const metadata: Metadata = { title: "免费练习 · 译洋", robots: { index: false, follow: false } };
export default function PromotionPage() { return <main className="free-access-page"><a href="/">返回练习</a><h1>全员免费，无需会员。</h1><p>写作、翻译批改与 AI 老师均免费开放，原会员推广活动已结束。</p><p>已有账号、草稿与批改记录继续保留。</p><footer>历史购买与售后问题，请联系官方 QQ 群 1059633594 的管理员；请勿在群内公开订单凭证、邮箱或密码。</footer></main>; }
