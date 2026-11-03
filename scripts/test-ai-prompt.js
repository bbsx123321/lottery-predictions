/**
 * AI 分析 prompt 生成自测
 *
 * 纯 node，不依赖微信运行时 —— 改了 utils/ai-prompt.js 就能立刻跑。
 *
 * 校验重点：**prompt 里的每个数字都要对得上独立算出来的结果**。
 * prompt 是喂给模型的输入，数字错了模型就会跟着胡说。
 *
 * 用法：node test-ai-prompt.js
 */
const { join } = require("node:path");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const analysis = require(path.join(root, "miniprogram", "utils", "analysis.js"));
const lottery = require(path.join(root, "miniprogram", "utils", "lottery.js"));
const promptMod = require(path.join(root, "miniprogram", "utils", "ai-prompt.js"));

let failures = 0;
let checks = 0;

function ok(cond, label, extra) {
  checks++;
  if (cond) {
    console.log("  [PASS] " + label + (extra ? "  " + extra : ""));
  } else {
    failures++;
    console.log("  [FAIL] " + label + (extra ? "  " + extra : ""));
  }
}

/** 固定种子的伪随机，保证每次跑出来的数据一样 */
function makeRandom(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 造一份历史开奖记录（新→旧） */
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

console.log("");
console.log("AI prompt 自测");
console.log("");

lottery.LOTTERIES.forEach(function (m) {
  console.log("=== " + m.name + " ===");
  const rows = makeDraws(m, 100, 7 + m.mainCount);

  ["main", "extra"].forEach(function (part) {
    if (part === "extra" && m.extraCount === 0) return;

    const out = promptMod.buildMetrics(rows, m, part, m.name);
    const freq = analysis.frequency(rows, m, part);

    ok(!!out.prompt, part + " 生成了 prompt");
    ok(out.prompt.indexOf(m.name) > -1, part + " prompt 含彩种名");
    ok(
      out.prompt.indexOf("近 " + rows.length + " 期") > -1,
      part + " prompt 含统计期数",
      rows.length + " 期"
    );

    // 热号必须跟独立算出来的一致
    const hotExpect = freq.hot.slice(0, 5).map(function (x) { return x.n; }).join(",");
    const hotActual = out.hot.map(function (x) { return x.n; }).join(",");
    ok(hotExpect === hotActual, part + " 热号与独立计算一致", hotActual);

    // 热号频次数字必须出现在 prompt 里
    const hotLine = out.hot
      .map(function (x) { return promptMod.pad(x.n) + "(" + x.count + "次)"; })
      .join("  ");
    ok(out.prompt.indexOf(hotLine) > -1, part + " prompt 里的热号频次正确", hotLine);

    // 统计指标条数固定
    ok(out.stats.length === 8, part + " 统计指标 8 条", String(out.stats.length));

    // 和值均值要对得上
    const sums = rows.map(function (r) {
      return analysis.sumOf(analysis.zoneOf(r, part));
    });
    const avg = Math.round(sums.reduce(function (a, b) { return a + b; }, 0) / rows.length);
    ok(
      out.prompt.indexOf("均值 " + avg) > -1,
      part + " prompt 里的平均和值正确",
      String(avg)
    );

    // 遗漏最久
    const byOm = freq.list.slice().sort(function (a, b) {
      return b.omission - a.omission || a.n - b.n;
    });
    ok(
      out.prompt.indexOf(promptMod.pad(byOm[0].n) + "(" + byOm[0].omission + "期)") > -1,
      part + " prompt 里的最长遗漏正确",
      promptMod.pad(byOm[0].n) + "(" + byOm[0].omission + "期)"
    );
  });
  console.log("");
});

// 空数据不能炸
console.log("=== 边界 ===");
const ssq = lottery.meta("ssq");
const empty = promptMod.buildMetrics([], ssq, "main", "双色球");
ok(empty.prompt === "", "空数据返回空 prompt");
ok(empty.stats.length === 0, "空数据返回空指标");
console.log("");

console.log("====================================================");
console.log(failures ? "自测失败：" + failures + " / " + checks : "全部通过：" + checks + " 项");
process.exit(failures ? 1 : 0);
