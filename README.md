# 译洋 · 四六级写作与翻译

面向大学英语四级、六级的写作与汉译英练习网站，支持 AI 批改、逐句对照、手写答案识别、错题本与学习目标。

采用 Next.js / React 静态前端、Node.js 24 后端和 SQLite。AI 请求由服务端调用 DeepSeek 官方 API，密钥不会发送到浏览器。

在线体验：[https://yiyangcet.xyz](https://yiyangcet.xyz) · 另一独立项目：[莎试笔雅 · 雅思写作练习室](https://github.com/shhsh993838383-hub/ssby-ielts-writing-studio)

## 功能

- 邮箱账号、账号隔离的草稿和批改历史；游客只读浏览。
- 四级 / 六级写作与翻译题库、自选题导入、手写答案 OCR（需自行配置 MinerU）。
- 客观评分、逐句修改、表达建议与修改稿；学习目标在评分后用于独立指导。
- 账号目标长期保存，草稿及目标同步包含版本冲突保护。
- AI 任务队列、排队进度和取消；两站共享时总并发 12、最多等待 30。
- 明暗主题、移动端界面、字数统计、计时、草稿与报告下载。
- 包含 Android Java WebView 与 Windows C# WebView2 客户端源码，见 [clients](clients/README.md)。

## 本机运行

需要 Node.js **24 或更新版本**，SQLite 使用 Node 内置模块。

```sh
git clone https://github.com/shhsh993838383-hub/yiyang-cet-writing-studio.git
cd yiyang-cet-writing-studio
npm ci
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填入自己的服务端 DEEPSEEK_API_KEY。
npm run build
npm run build:vps
npm start
```

Windows PowerShell 可用 `Copy-Item .dev.vars.example .dev.vars` 替代 `cp`。访问 http://127.0.0.1:3002 。不填 API 密钥时仍可浏览题库与使用本机练习功能，AI 请求会提示服务未配置。

后端开发：`npm run dev:node`；前端预览：`npm run dev:ui`（前端单独启动不提供完整 API）。界面变动后重新构建静态资源。

## 配置与数据

示例配置为官方接口 `https://api.deepseek.com`、`deepseek-flash`、`DEEPSEEK_STREAM=true`。真实密钥仅保存在被 Git 忽略的环境文件。生产可用环境变量覆盖，说明见 [.dev.vars.example](.dev.vars.example)。

业务数据库默认 storage/cet-writing.sqlite。题库、公开样卷与整理资料保留各自出处和转写限制；304 道第三方真题记录之外另有补充翻译，不能宣称覆盖所有历年真题。OCR 需配置 MINERU_COMMAND，识别后应核对题面和答案。

自托管步骤见 [deploy/vps/README.md](deploy/vps/README.md)。默认独立账号库；共享身份与队列需要显式迁移和配置，不包含任何线上数据。

## 验证

```sh
npm run typecheck
npm test
npm run build
npm run build:vps
```

真实 OCR / AI 联调需要自己的服务配置，可能产生服务费用。安装包发布需自行准备 SDK 与私有签名；源码仓库不分发已编译安装包。

## 许可证与边界

原创代码采用 [MIT](LICENSE)。第三方依赖、题目、题图、考试样卷及资料仍遵循各自的权利与许可，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目与考试机构、教材作者无官方隶属关系。

AI 评分仅供学习参考，不代替人工或正式考试评分，不承诺达到目标分。开源版本不包含用户数据、密钥、签名私钥、教材全文、运维备份或收款码。
