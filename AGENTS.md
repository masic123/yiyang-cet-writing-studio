# 项目维护约定

- 不提交真实环境配置、私钥、用户数据库、用户作文、备份、日志、教材全文或收款码。示例配置只保留空密钥。
- 默认使用 DeepSeek 官方 API https://api.deepseek.com、模型 deepseek-flash、DEEPSEEK_STREAM=true，保持中转兼容解析实现。
- 目标分独立于客观评分输入与缓存，保持账号隔离、版本冲突保护与旧草稿保护。
- 两站共享部署时 AI 并发合计 12、最大等待 30；保留队列与业务数据。
- 正式网站更新前运行 scripts/prepare-client-release.mjs，同时构建 APK 与 EXE，并校验版本递增、字节数、SHA-256、下载清单及旧客户端升级提醒。不得替换官方 Android 升级签名或强制关闭有未保存练习的客户端。开源源码同步与网站上线分别操作。
- 修改 Next.js 相关代码前读取当前依赖中的 node_modules/next/dist/docs/，按已安装版本实现并验证。
