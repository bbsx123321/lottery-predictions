/**
 * 生成云函数里的 AI 预置配置
 *
 * 为什么要有这个脚本：
 *   小程序代码包是明文分发的，API key 写进包里会被任何人反编译拿到。
 *   所以预置 key 只放在云函数（cloudfunctions/api/ai-config.js），
 *   前端通过 getAIConfig 动作按需取。
 *
 * key 来源：本机 ~/.pencil/agent-auth 里的 minimax 项。
 * 这个文件不进公开仓库（.gitignore 已加）。
 *
 * 用法：node sync-ai-config.js [--project <项目根>]
 */
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { homedir } = require("node:os");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const projectRoot = resolve(arg("--project", join(__dirname, "..")));
const authFile = join(homedir(), ".pencil", "agent-auth");
const outFile = join(projectRoot, "cloudfunctions", "api", "ai-config.js");

/** MiniMax 的 Anthropic 兼容端点 */
const BASE_URL = "https://api.minimaxi.com/anthropic/v1";

/** 可选模型（key 必须与账号开通的模型一致） */
const MODELS = [
  { key: "MiniMax-M3.1-Flash", name: "M3.1-Flash · 快，日常够用" },
  { key: "MiniMax-M3", name: "M3 · 强，深度分析用" },
];

function loadKey() {
  if (!existsSync(authFile)) {
    throw new Error("找不到 " + authFile + "（本机没有 minimax 凭据）");
  }
  const auth = JSON.parse(readFileSync(authFile, "utf8"));
  const entry = auth.minimax;
  const key = entry && (entry.key || entry.value);
  if (!key) throw new Error("agent-auth 里没有 minimax key");
  return key;
}

const key = loadKey();

const body = `/**
 * AI 服务端预置配置 —— 由 scripts/sync-ai-config.js 自动生成，勿手改
 *
 * ⚠️ 这个文件里有服务端预置的 AI 凭据，**不要提交到公开仓库**
 *    （.gitignore 里已经排除了它）。
 *
 * 为什么预置 key 要放在云函数里：
 *   小程序代码包是明文分发的，key 写进去会被任何人反编译拿到。
 *   所以预置 key 只存在云函数，由 getAIConfig 动作按需下发给客户端。
 *
 * 换 key / 换模型：改 scripts/sync-ai-config.js 里的 BASE_URL / MODELS，
 * 然后重跑 node scripts/sync-ai-config.js 再重新部署云函数。
 */
module.exports = {
  baseUrl: ${JSON.stringify(BASE_URL)},
  models: ${JSON.stringify(MODELS, null, 2).replace(/\n/g, "\n  ")},
  apiKey: ${JSON.stringify(key)},
};
`;

writeFileSync(outFile, body, "utf8");

console.log("已生成 : " + outFile);
console.log("端点   : " + BASE_URL);
console.log("模型   : " + MODELS.map(function (m) { return m.key; }).join(", "));
console.log("key    : 已写入（长度 " + key.length + "，不打印内容）");
