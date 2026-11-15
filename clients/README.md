# 译洋客户端源码

Android 为 Java WebView 客户端，Windows 为 C# WinForms / WebView2 客户端；两者包含版本检查和保留练习的稍后升级流程。

版本集中在 release-config.json。build.py 需要 Python 3 + Pillow、JDK、Android SDK Build Tools / Platform、WebView2 .NET SDK 与 NSIS；按脚本预期布局在 clients/tools 中准备，工具与输出不进入 Git。Windows 编译使用系统 .NET Framework 编译器。

Android 发布需要自行保管的 clients/private/yiyang-android-release.p12 及 keystore-password.txt，并在 release-config.json 配置对应证书 SHA-256。现有官方签名密钥不公开，也不得用新密钥替换官方客户端升级签名。自行分发时使用自己的应用标识、域名与签名。

官方客户端发布先运行 npm run release:prepare；脚本检查线上版本递增、同时构建 APK 与 EXE，并校验字节数和 SHA-256 后更新下载清单。支持 CLIENT_SOURCE_DIRECTORY、PYTHON_COMMAND、YIYANG_APP_BUILD_ROOT。仅开源源码不会触发线上发布或增加客户端版本。

安装包由发布者单独分发，不写入源码仓库；官方现有安装包见 https://yiyangcet.xyz/download 。
