/**
 * 自测：cloudfunctions/api/sources.js 的 fetchUpstream 能不能真的取到 N 期
 *
 * 为什么要测：
 *   翻页逻辑改过（issueCount 必须留空、体彩 pageSize 锁 100），
 *   而云函数部署上去再试错很慢 —— 本地能跑就直接跑。
 *
 * 用法：node test-sources-fetch.js
 */
const path = require("node:path");
const { fetchUpstream } = require(path.join(__dirname, "..", "cloudfunctions", "api", "sources.js"));

const KEYS = ["ssq", "fc3d", "kl8", "dlt"];
const NS = [1, 100, 300, 500];

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

function rangeOf(rows) {
  const ps = rows.map(function (r) { return String(r.period); });
  const s = ps.slice().sort(function (a, b) { return a.localeCompare(b); });
  return s[0] + " ~ " + s[s.length - 1];
}

async function main() {
  console.log("sources.js · fetchUpstream 自测");
  console.log("");

  for (const key of KEYS) {
    console.log("=== " + key + " ===");
    for (const n of NS) {
      const t0 = Date.now();
      let rows = null;
      let err = null;
      try {
        rows = await fetchUpstream(key, n);
      } catch (e) {
        err = (e && e.message) || String(e);
      }
      const ms = Date.now() - t0;

      if (err) {
        ok(false, "取 " + n + " 期", "失败: " + err);
        continue;
      }

      const uniq = new Set(rows.map(function (r) { return r.period; })).size;
      const bad = rows.filter(function (r) {
        return !r.period || !Array.isArray(r.numbers) || !r.numbers.length;
      }).length;

      ok(rows.length === n, "取 " + n + " 期 -> 实得 " + rows.length + " 期", rangeOf(rows) + "  " + ms + "ms");
      ok(uniq === rows.length, "期号无重复", uniq + " 个唯一");
      ok(bad === 0, "每期都有号码", bad ? bad + " 期缺号码" : "");

      // 期号必须是新的在前
      const sorted = rows.slice().sort(function (a, b) {
        return String(b.period).localeCompare(String(a.period));
      });
      ok(
        rows.every(function (r, i) { return r.period === sorted[i].period; }),
        "期号新的在前"
      );
    }
    console.log("");
  }

  console.log("====================================================");
  console.log(failures ? "自测失败：" + failures + " / " + checks : "全部通过：" + checks + " 项");
  process.exit(failures ? 1 : 0);
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
