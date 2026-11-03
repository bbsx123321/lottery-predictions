/**
 * 走势图算法层本地自测
 * 用合成的开奖记录验证 36 种算法都能产出结构完整的表格。
 *
 * 用法：node scripts/test-trend.js
 */
const path = require("node:path");
const trend = require(path.join(__dirname, "..", "miniprogram", "utils", "trend.js"));
const { meta } = require(path.join(__dirname, "..", "miniprogram", "utils", "lottery.js"));

/** 造 N 期开奖记录（新的在前） */
function fake(lotteryKey, n) {
  const m = meta(lotteryKey);
  const out = [];
  let seed = 20260101;
  function rnd() {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  }
  for (let i = 0; i < n; i++) {
    const pool = [];
    for (let v = m.mainMin; v <= m.mainMax; v++) pool.push(v);
    const main = [];
    for (let k = 0; k < m.mainCount; k++) {
      main.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    }
    const extra = [];
    if (m.extraCount > 0) {
      const ep = [];
      for (let v = m.extraMin; v <= m.extraMax; v++) ep.push(v);
      for (let k = 0; k < m.extraCount; k++) {
        extra.push(ep.splice(Math.floor(rnd() * ep.length), 1)[0]);
      }
    }
    if (m.ordered) {
      // 3D 保留顺序
    } else {
      main.sort(function (a, b) { return a - b; });
      extra.sort(function (a, b) { return a - b; });
    }
    const d = new Date(2026, 0, 1 + i * 3);
    const date =
      d.getFullYear() +
      "-" + String(d.getMonth() + 1).padStart(2, "0") +
      "-" + String(d.getDate()).padStart(2, "0");
    out.push({
      period: String(2026001 + i),
      date: date,
      numbers: main,
      extras: extra,
    });
  }
  return out;
}

let fail = 0;
function check(cond, msg) {
  if (!cond) {
    fail++;
    console.log("  FAIL " + msg);
  }
}

console.log("算法总数 = " + trend.algoCount() + "（期望 36）");
check(trend.algoCount() === 36, "算法总数应为 36");

const LOTTERIES = ["ssq", "dlt", "fc3d", "kl8"];

LOTTERIES.forEach(function (key) {
  const menu = trend.menuOf(key);
  console.log("");
  console.log("=== " + meta(key).name + " · " + menu.length + " 种算法 ===");
  check(menu.length > 0, key + " 菜单为空");

  const seen = {};
  menu.forEach(function (item) {
    check(!!trend.algoOf(item.key), key + " 未知算法 " + item.key);
    check(!seen[item.key], key + " 菜单算法重复 " + item.key);
    seen[item.key] = 1;
  });

  const draws = fake(key, 40);
  menu.forEach(function (item) {
    const t = trend.build(draws, key, item.key, { periods: 30, desc: false });
    const spec = trend.algoOf(item.key);

    check(!!t, item.key + " 构建失败");
    if (!t) return;
    check(t.rows.length > 0, item.key + " 没有数据行");
    check(t.columns.length > 0, item.key + " 没有列");
    check(t.groups.length > 0, item.key + " 没有表头分组");

    // 分组跨度之和必须等于列数
    const span = t.groups.reduce(function (a, g) { return a + g.span; }, 0);
    check(span === t.columns.length, item.key + " 分组跨度 " + span + " != 列数 " + t.columns.length);

    // 每行单元格数必须等于列数
    const bad = t.rows.filter(function (r) { return r.cells.length !== t.columns.length; });
    check(bad.length === 0, item.key + " 有 " + bad.length + " 行列数不匹配");

    // 每个单元格都要有文本
    let empty = 0;
    t.rows.forEach(function (r) {
      r.cells.forEach(function (c) {
        if (c.text === undefined || c.text === null || c.text === "") empty++;
      });
    });
    check(empty === 0, item.key + " 有 " + empty + " 个空单元格");

    // 矩阵类：命中格要显示号码，未命中格要显示遗漏值
    if (spec.kind === "matrix") {
      let hitBad = 0;
      t.rows.forEach(function (r) {
        r.cells.forEach(function (c) {
          if (c.hit && !/^\d+$/.test(c.text)) hitBad++;
        });
      });
      check(hitBad === 0, item.key + " 命中格文本异常 " + hitBad);
    }

    // 星期类：行数应该比总期数少
    if (spec.weekday) {
      check(t.rows.length < 30, item.key + " 星期筛选没生效");
    }
  });
});

/* ---- 抽查一张号码矩阵的遗漏值是否正确 ---- */
console.log("");
console.log("=== 抽查遗漏值 ===");
const draws = fake("ssq", 10);
const t = trend.build(draws, "ssq", "main", { periods: 10, desc: false });
const colIdx = t.columns.findIndex(function (c) { return c.n === 5; });
let ok = true;
for (let r = 0; r < t.rows.length; r++) {
  const c = t.rows[r].cells[colIdx];
  if (c.hit) {
    if (c.text !== "05") ok = false;
  } else {
    // 未命中：遗漏值 = 连续未出现的期数（含本期），命中后的下一期显示 1
    let expect = 0;
    for (let k = r; k >= 0; k--) {
      if (t.rows[k].cells[colIdx].hit) break;
      expect++;
    }
    if (Number(c.text) !== expect) ok = false;
  }
}
check(ok, "遗漏值与命中序列对不上");

console.log("");
console.log(fail === 0 ? "全部通过" : "有 " + fail + " 项未通过");
process.exit(fail === 0 ? 0 : 1);
