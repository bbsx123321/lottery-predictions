/**
 * 开奖数据源新鲜度探针
 *
 * 直接打四个彩种的官方上游接口，报告「上游现在最新一期到哪了」，
 * 以及拉取耗时。用它判断：
 *   - 上游接口还活着吗（是否官方改版/限流）
 *   - 今天的开奖结果上游放出来了没
 *   - 云库里的数据是不是落后于上游
 *
 * 用法：
 *   node probe-sources.js            # 探四个彩种，各取 100 期
 *   node probe-sources.js --limit 20 # 换个期数
 *   node probe-sources.js --verbose  # 顺便打印最新一期的号码明细
 */

const path = require("path");
const {
  LOTTERIES,
  fetchUpstream,
} = require(path.join(__dirname, "..", "cloudfunctions", "api", "sources.js"));

function parseArgs(argv) {
  const opts = { limit: 100, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit" && argv[i + 1]) {
      opts.limit = parseInt(argv[i + 1], 10) || opts.limit;
      i++;
    } else if (argv[i] === "--verbose") {
      opts.verbose = true;
    }
  }
  return opts;
}

function pad(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padStart(text, width) {
  const s = String(text);
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

/** 3D 和快乐8 每天开；双色球(二四日)、大乐透(一三六)隔天开 */
function expectedToday(now) {
  const dow = now.getDay(); // 0=周日 1=周一 2=周二 3=周三 4=周四 5=周五 6=周六
  const list = [];
  if (dow === 2 || dow === 4 || dow === 0) list.push("双色球");
  if (dow === 1 || dow === 3 || dow === 6) list.push("大乐透");
  list.push("福彩3D", "快乐8");
  return list;
}

const DOW_CN = ["日", "一", "二", "三", "四", "五", "六"];

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  console.log("开奖数据源新鲜度探针");
  console.log("本地时间   :", now.toLocaleString("zh-CN"), "（周" + DOW_CN[now.getDay()] + "）");
  console.log("今日应开奖 :", expectedToday(now).join("、"));
  console.log("拉取期数   :", opts.limit, "期 / 彩种");
  console.log("=".repeat(72));

  const keys = Object.keys(LOTTERIES);
  let okCount = 0;

  for (const key of keys) {
    const meta = LOTTERIES[key];
    const t0 = Date.now();
    try {
      const rows = await fetchUpstream(key, opts.limit);
      const cost = Date.now() - t0;
      okCount++;
      const latest = rows[0] || {};
      const fresh = latest.date === today ? "今日已开" : "上一期";

      console.log(
        "  [" + (rows.length ? "OK" : "空") + "] " +
        pad(meta.name, 8) +
        pad("最新 " + (latest.period || "-"), 18) +
        pad(latest.date || "-", 14) +
        pad(fresh, 12) +
        padStart(cost + "ms", 9) +
        "  " + rows.length + " 期"
      );
      if (opts.verbose && latest.numbers) {
        console.log("           号码: " + latest.numbers.join(" ") +
          (latest.extras && latest.extras.length ? "  |  " + latest.extras.join(" ") : "") +
          "   销量 " + (latest.sales || "-") + "  奖池 " + (latest.pool || "-"));
      }
    } catch (e) {
      console.log(
        "  [ERR] " + pad(meta.name, 8) +
        padStart(Date.now() - t0 + "ms", 9) + "  " + ((e && e.message) || "拉取失败")
      );
    }
  }

  console.log("=".repeat(72));
  console.log(okCount + "/" + keys.length + " 个上游连通");
  if (okCount < keys.length) {
    console.log("有上游异常，先看上面的 ERR 行 —— 多半是官方限流或接口改版。");
    process.exitCode = 1;
  }
}

main().catch(function (e) {
  console.error("探针异常:", (e && e.stack) || e);
  process.exitCode = 1;
});
