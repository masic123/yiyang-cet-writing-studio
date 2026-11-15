// One-use loopback form. The key never appears in logs, browser URLs, or tool results.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const statePath = path.join(project, "storage", "secret-setup-status.json");
fs.mkdirSync(path.dirname(statePath), { recursive: true });
const state = (status) =>
  fs.writeFileSync(
    statePath,
    JSON.stringify({ status, updatedUtc: new Date().toISOString() }),
  );
const token = randomBytes(24).toString("hex");
let consumed = false;
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>句读 · 配置 DeepSeek</title><style>*{box-sizing:border-box}body{margin:0;background:#f1f1e9;color:#233c32;font-family:system-ui,'Microsoft YaHei',sans-serif;min-height:100dvh;display:grid;place-items:center;padding:24px}.box{width:min(100%,490px);background:#fffef9;border:1px solid #d4d8cc;border-radius:16px;padding:38px;box-shadow:0 22px 70px #213e3214}h1{font-size:27px;margin:0 0 16px}p{color:#566359;line-height:1.9;font-size:14px}label{display:block;font-weight:600;margin-top:25px;font-size:14px}input{width:100%;padding:14px;border:1px solid #87968b;border-radius:8px;font-size:18px;margin-top:10px;background:#fff;color:#162c23}input:focus-visible{outline:3px solid #407c5a55;outline-offset:2px}button{margin-top:24px;padding:13px 22px;width:100%;border:0;border-radius:8px;background:#234d3e;color:white;font-size:15px;cursor:pointer}button:disabled{opacity:.6}#status{min-height:24px;color:#9d392c}small{display:block;color:#566359;line-height:1.8;margin-top:18px}</style><main class="box"><h1>连接你的 DeepSeek</h1><p>这是本机配置窗口。密钥只会保存到网站的服务器配置文件，不会进入聊天记录。</p><form id="form"><label for="key">DeepSeek API Key</label><input id="key" type="password" autocomplete="off" spellcheck="false" autofocus required minlength="20" maxlength="256" aria-describedby="status"><button id="save" type="submit">保存配置</button><p id="status" role="status" aria-live="polite"></p></form><small>仅在本机 127.0.0.1 接收输入。配置成功后，这个一次性窗口将停止接收数据。</small></main><script>const form=document.getElementById('form'),key=document.getElementById('key'),button=document.getElementById('save'),status=document.getElementById('status');form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;status.textContent='正在保存…';try{const response=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:key.value.trim()})});const data=await response.json();if(!response.ok)throw new Error(data.error);key.value='';key.disabled=true;status.style.color='#234d3e';status.textContent='已保存。你可以关闭此配置窗口，返回网站。';button.textContent='配置已保存';}catch(error){status.textContent=error.message||'保存失败，请重试。';button.disabled=false;}});</script></html>`;
const server = http.createServer(async (req, res) => {
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
  };
  if (req.url !== `/${token}` || consumed) {
    res.writeHead(404, headers);
    res.end();
    return;
  }
  if (req.method === "GET") {
    res.writeHead(200, {
      ...headers,
      "Content-Type": "text/html; charset=utf-8",
    });
    res.end(page);
    return;
  }
  if (
    req.method !== "POST" ||
    req.headers.origin !== `http://127.0.0.1:${server.address().port}` ||
    req.headers["content-type"] !== "application/json"
  ) {
    res.writeHead(403, headers);
    res.end();
    return;
  }
  try {
    let payload = "";
    for await (const bytes of req) {
      payload += bytes.toString("utf8");
      if (payload.length > 2048) throw new Error("输入过长。");
    }
    const { key } = JSON.parse(payload);
    if (typeof key !== "string" || !key.match(/^[A-Za-z0-9._-]{20,256}$/))
      throw new Error("请检查密钥是否完整，并去掉空格或换行。");
    state("checking");
    let verification;
    try {
      verification = await fetch("https://api.deepseek.com/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      state("rejected");
      res.writeHead(400, { ...headers, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "连接超时，请稍后重试。" }));
      return;
    }
    if (!verification.ok) {
      state("rejected");
      const message =
        verification.status === 401
          ? "官方接口认证未通过。请重新复制完整的有效 API Key，不要粘贴账户密码。"
          : `官方接口暂时无法验证（${verification.status}），请稍后重试。`;
      res.writeHead(400, { ...headers, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
      return;
    }
    const destination = path.join(project, ".env.local");
    const text = fs.readFileSync(
      fs.existsSync(destination)
        ? destination
        : path.join(project, ".env.example"),
      "utf8",
    );
    const config = text
      .split(/\r?\n/)
      .filter((line) => !/^\s*DEEPSEEK_API_KEY\s*=/.test(line));
    config.push(`DEEPSEEK_API_KEY=${key}`);
    fs.writeFileSync(destination, config.join("\n"), { mode: 0o600 });
    const workerVars = path.join(project, ".dev.vars");
    const existing = fs.existsSync(workerVars)
      ? fs.readFileSync(workerVars, "utf8")
      : "";
    fs.writeFileSync(
      workerVars,
      existing
        .split(/\r?\n/)
        .filter((line) => !/^\s*DEEPSEEK_API_KEY\s*=/.test(line))
        .concat(`DEEPSEEK_API_KEY=${key}`)
        .join("\n"),
      { mode: 0o600 },
    );
    consumed = true;
    state("saved");
    res.writeHead(200, { ...headers, "Content-Type": "application/json" });
    res.end('{"saved":true}');
    console.log("Configuration saved. Key was not logged.");
    server.close();
  } catch (error) {
    res.writeHead(400, { ...headers, "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error:
          error instanceof SyntaxError
            ? "输入格式不正确。"
            : "保存失败，请检查密钥后重试。",
      }),
    );
  }
});
server.listen(0, "127.0.0.1", () => {
  state("open");
  console.log(`CONFIG_URL=http://127.0.0.1:${server.address().port}/${token}`);
});
setTimeout(
  () => {
    if (!consumed) {
      state("expired");
      server.close();
    }
  },
  30 * 60 * 1000,
).unref();
