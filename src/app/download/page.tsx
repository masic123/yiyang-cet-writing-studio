import type { Metadata } from "next";
import releases from "@/lib/client-downloads.json";
import styles from "./page.module.css";
import { AndroidLogo, WindowsLogo, ArrowDown, ArrowRight } from "@phosphor-icons/react/dist/ssr";
export const metadata: Metadata = { title: "下载客户端 · 译洋", description: "下载译洋安卓 APK 和 Windows 安装包，用现有账号练习四六级写作与翻译。" };
const size = (bytes: number) => bytes < 1048576 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
export default function DownloadPage() {
  return <main className={styles.page}>
    <header className={styles.header}>
      <a href="/" className={styles.brand}><img src="/apple-touch-icon-v20261029.png" width="40" height="40" alt="" /><strong>译洋</strong></a>
      <a href="/" className={styles.returnLink}>返回练习 <span aria-hidden="true">↗</span></a>
    </header>
    <section className={styles.content} aria-labelledby="download-title">
      <h1 id="download-title">下载译洋</h1>
      <p className={styles.intro}>使用现有账号，继续你的练习。</p>
      <div className={styles.cards}>
        <article className={styles.card}>
          <AndroidLogo size={40} weight="regular" aria-hidden="true" />
          <h2>Android</h2><p>适用于 Android 8.0 及以上</p>
          <a className={styles.download} href={`/downloads/${releases.android.file}`} download>下载安卓 APK <ArrowDown size={18} aria-hidden="true" /></a>
          <small>v{releases.android.version} · {size(releases.android.bytes)}</small>
        </article>
        <article className={styles.card}>
          <WindowsLogo size={40} weight="regular" aria-hidden="true" />
          <h2>Windows</h2><p>适用于 Windows 10 / 11，64 位</p>
          <a className={styles.download} href={`/downloads/${releases.windows.file}`} download>下载 Windows 安装包 <ArrowDown size={18} aria-hidden="true" /></a>
          <small>v{releases.windows.version} · {size(releases.windows.bytes)}</small>
        </article>
      </div>
      <div className={styles.notes}>
        <p>客户端需要联网，首次使用时请登录现有账号。</p>
        <details><summary>安装说明</summary><div>
          <p>安卓：下载 APK 后，按手机系统提示安装。部分浏览器内无法下载时，可在系统浏览器打开本页。</p>
          <p>Windows：运行安装包完成安装。若缺少 WebView2，安装程序会联网安装微软官方运行时。当前安装包尚未配置发布者数字签名。</p>
          <p>新版客户端会自动检查更新并提示下载，可直接覆盖安装。安装 Windows 更新前，请先保存练习并关闭客户端。</p>
          <p>安卓客户端导出批改报告时，请使用浏览器版。</p>
        </div></details>
        <details><summary>版本与文件校验</summary><div className={styles.checksums}>
          <p>Android {releases.android.version} / Windows {releases.windows.version} · 发布日期 {releases.publishedAt}</p>
          <span>Android · SHA-256</span><code>{releases.android.sha256}</code>
          <span>Windows · SHA-256</span><code>{releases.windows.sha256}</code>
        </div></details>
      </div>
    </section>
    <footer className={styles.footer}><span>译洋</span><a href="/">继续网页版练习 <ArrowRight size={16} aria-hidden="true" /></a></footer>
  </main>;
}
