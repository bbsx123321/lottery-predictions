/**
 * 探针：prompt 长度随「统计期数」怎么变
 *
 * 为什么关心这个：
 *   AI 分析喂给模型的是**聚合指标**，不是原始开奖记录。
 *   所以理论上期数翻 3 倍，prompt 不会跟着翻 3 倍 ——
 *   这决定了「把分析窗口从 100 期放宽到 300 期」的代价有多大。
 *
 * 用法：node probe-prompt-size.js
 */
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const lottery = require(path.join(root, "miniprogram", "utils", "lottery.js"));
const promptMod = require(path.join(root, "miniprogram", "utils", "ai-prompt.js"));

/** 固定种子的伪随机，保证每次跑出来的数据一样 */
function makeRandom(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeDraws(m, count, seed) {
  const rnd = makeRandom(seed);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const pool = [];
    for (let n = m.mainMin; n <= m.mainMax; n++) pool.push(n);
    const main = [];
    for (let k = 0; k < m.mainCount; k++) {
      main.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    }
    if (!m.ordered) main.sort(function (a, b) { return a - b; });

    const extras = [];
    if (m.extraCount > 0) {
      const epool = [];
      for (let n = m.extraMin; n <= m.extraMax; n++) epool.push(n);
      for (let k = 0; k < m.extraCount; k++) {
        extras.push(epool.splice(Math.floor(rnd() * epool.length), 1)[0]);
      }
      extras.sort(function (a, b) { return a - b; });
    }

    rows.push({
      period: String(2026000 + count - i),
      date: "2026-01-01",
      numbers: main,
      extras: extras,
    });
  }
  return rows;
}

const PERIODS = [30, 50, 100, 200, 300];

console.log("prompt 长度随统计期数的变化（喂的是聚合指标，不是原始记录）");
console.log("");

for (const key of ["ssq", "dlt"]) {
  const m = lottery.meta(key);
  const rows = makeDraws(m, 300, 7 + m.mainCount);
  console.log("=== " + m.name + " · 主区 ===");
  const base = {};
  for (const p of PERIODS) {
    const out = promptMod.buildMetrics(rows.slice(0, p), m, "main", m.name);
    base[p] = out.prompt.length;
    console.log(
      "  近 " + String(p).padStart(3) + " 期 -> prompt " +
        String(out.prompt.length).padStart(4) + " 字" +
        "  指标 " + out.stats.length + " 条" +
        "  折合 " + Math.round(out.prompt.length / p * 100) / 100 + " 字/期"
    );
  }
  console.log(
    "  → 30 期 → 300 期，prompt 只长了 " +
      (base[300] - base[30]) + " 字（+" + Math.round((base[300] / base[30] - 1) * 100) + "%）"
  );
  console.log("");
}
