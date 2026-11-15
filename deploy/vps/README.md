# 自托管

先按根目录 README 安装依赖并构建，再将静态资源与 Dockerfile 放到服务端构建目录：

```sh
npm run build
npm run build:vps
node -e "const fs=require('fs');fs.cpSync('out','storage/vps-release/out',{recursive:true});fs.copyFileSync('deploy/vps/Dockerfile','storage/vps-release/Dockerfile')"
cp deploy/vps/.env.example deploy/vps/.env
# 编辑 .env：实际 HTTPS 域名、自己的 API 密钥与注册策略。
docker compose -f deploy/vps/compose.yml up -d --build
```

通过自己的 HTTPS 反向代理转发到 127.0.0.1:8789，由可信代理接入时设置 TRUST_PROXY=true。SQLite 存于持久卷 writing-data，更新前先备份业务数据库与单独保存的环境配置。密钥、用户数据库和备份均不进入源码仓库。

两个仓库默认各自独立运行。若要共享账号，需要先迁移并挂载同一身份数据库，再配置 IDENTITY_DATABASE_PATH；两站必须使用同一个独立 AI 队列库（共享并发 12、最多等待 30），不可通过覆盖现有数据库进行合并。

本仓库不附 MinerU 凭据；OCR 需要自行完成 MinerU 配置。网站正式更新需按 clients/README.md 同步发布两个客户端，保持版本和下载清单一致。
