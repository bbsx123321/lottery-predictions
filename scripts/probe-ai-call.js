/**
 * AI 端点探针 —— 从本机直连 MiniMax（Anthropic 兼容协议）
 *
 * 用途：
 *   1. 验证「客户端直连」这条路真的通（端点、key、请求格式）
 *   2. 给小程序前端（miniprogram/utils/ai.js）定下准确的请求格式和响应结构
 *
 * key 从 ~/.pencil/agent-auth 读，**只在本机用**，
 * 不会打印出来，也不会进小程序代码包。
 *
 * 用法：node probe-ai-call.js [--prompt "问点什么"] [--model MiniMax-M3.1-Flash]
 */
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE_URL = arg("--base", "https://api.minimaxi.com/anthropic/v1");
const MODEL = arg("--model", "MiniMax-M3.1-Flash");
const PROMPT = arg("--prompt", "用一句话说你好");

function loadKey() {
  const raw = readFileSync(join(homedir(), ".pencil", "agent-auth"), "utf8");
  const auth = JSON.parse(raw);
  const entry = auth.minimax;
  const key = entry && (entry.key || entry.value);
  if (!key) throw new Error("~/.pencil/agent-auth 里没有 minimax key");
  return key;
}

async function main() {
  const key = loadKey();
  console.log("端点   : " + BASE_URL + "/messages");
  console.log("模型   : " + MODEL);
  console.log("提示词 : " + PROMPT);
  console.log("");

  const t0 = Date.now();
  const res = await fetch(BASE_URL + "/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 512,
      messages: [{ role: "user", content: PROMPT }],
    }),
  });

  const text = await res.text();
  console.log("HTTP   : " + res.status + " " + res.statusText);
  console.log("耗时   : " + (Date.now() - t0) + "ms");
  console.log("");

  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    console.log("非 JSON 响应：");
    console.log(text.slice(0, 800));
    process.exit(1);
  }

  if (!res.ok) {
    console.log("错误响应：");
    console.log(JSON.stringify(json).slice(0, 1200));
    process.exit(1);
  }

  console.log("响应结构（顶层字段）：" + Object.keys(json).join(", "));
  console.log("stop_reason   : " + json.stop_reason);
  console.log("usage         : " + JSON.stringify(json.usage || {}));
  console.log("content 段数  : " + ((json.content || []).length));
  console.log("");
  console.log("模型回复：");
  (json.content || []).forEach(function (c) {
    console.log("  [" + c.type + "] " + String(c.text || "").slice(0, 500));
  });
}

main().catch(function (err) {
  console.error("探针失败: " + ((err && err.message) || err));
  process.exit(1);
});
