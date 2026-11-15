import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import "./font-size.css";
import "../components/question-cards.css";
import "../components/leaderboard.css";
import "./mobile.css";
import "../components/membership.css";
import "../components/practice-header.css";
import "../components/sentence-practice.css";
import "../components/supplementary-resources.css";
import "../components/ai-teacher.css";
import "../components/target-coaching.css";
import "./refined-studio.css";
import "./studio-motion.css";
import { fontSizeBootstrap } from "@/lib/font-size";
const manrope = localFont({
  src: "../../node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2",
  variable: "--font-manrope",
  display: "swap",
});
export const metadata: Metadata = {
  title: "译洋 · 四六级写作与翻译",
  icons: {
    icon: [{ url: "/favicon-v20261029.png", type: "image/png", sizes: "32x32" }],
    shortcut: "/favicon.ico?v=20261029",
    apple: [{ url: "/apple-touch-icon-v20261029.png", sizes: "180x180" }],
  },
  description:
    "四级与六级写作、翻译真题练习，整体15分档评价、逐句修改、原意核对和官方评分样卷对照。",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" className={manrope.variable} suppressHydrationWarning>
      <head>
        <link rel="stylesheet" href="/brand-icons-v20261029.css" />
        <script dangerouslySetInnerHTML={{ __html: fontSizeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
