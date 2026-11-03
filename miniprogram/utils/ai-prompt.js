/**
 * AI 分析 —— 把开奖数据变成「指标摘要 + 喂给模型的 prompt」
 *
 * 设计要点：
 *   1. **所有数字都在前端算**（复用 utils/analysis.js 的纯函数），
 *      不让模型自己去数数 —— 模型数不准，数字必须由代码给。
 *   2. prompt 里给的是**结构化的中文指标**，不是原始开奖记录。
 *      原始记录太长会吃掉上下文，而且模型容易看串期。
 *   3. prompt 同时给出**输出结构要求**（结论 / 观察 / 误区），
 *      这样每次返回的排版一致，页面好渲染。
 *
 * 纯函数，不依赖 wx / 云函数 —— 可以直接用 node 自测。
 */
const analysis = require("./analysis.js");

/** 号码补零（01-09） */
function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

/** 取 top N 个 */
function topN(list, n) {
  return list.slice(0, n);
}

/**
 * 从「组合 → 次数」的映射里取出现最多的那个
 *
 * analysis.js 里有个 topCombo，但它吃的是字符串数组（要先展开成重复项），
 * 这里直接吃 map，更省事。analysis.js 没导出它，所以自己实现一份。
 */
function topOfMap(map, total) {
  let combo = "";
  let count = 0;
  Object.keys(map).forEach(function (k) {
    if (map[k] > count) {
      combo = k;
      count = map[k];
    }
  });
  return { combo: combo, count: count, rate: total ? count / total : 0 };
}

/**
 * 算指标 + 生成 prompt
 *
 * @param {Array} rows 历史开奖（新→旧）
 * @param {object} m 彩种元信息（utils/lottery.js 的 meta()）
 * @param {string} part 'main' | 'extra'
 * @param {string} lotteryName 彩种名
 * @returns {{part:string, partLabel:string, stats:Array, hot:Array, cold:Array, missing:Array, prompt:string}}
 */
function buildMetrics(rows, m, part, lotteryName) {
  const list = rows || [];
  const n = list.length;
  const partLabel = part === "extra" ? m.extraLabel : m.mainLabel;
  const range = analysis.rangeOf(m, part);

  if (!n) {
    return {
      part: part,
      partLabel: partLabel,
      stats: [],
      hot: [],
      cold: [],
      missing: [],
      prompt: "",
    };
  }

  const freq = analysis.frequency(list, m, part);

  // 号码个数（每期几个）
  const perPeriod = part === "extra" ? m.extraCount : m.mainCount;

  // ---- 和值 / 跨度 ----
  const sums = list.map(function (r) {
    return analysis.sumOf(analysis.zoneOf(r, part));
  });
  const spans = list.map(function (r) {
    return analysis.spanOf(analysis.zoneOf(r, part));
  });
  const sumMin = Math.min.apply(null, sums);
  const sumMax = Math.max.apply(null, sums);
  const sumAvg = Math.round(sums.reduce(function (a, b) { return a + b; }, 0) / n);
  const spanMin = Math.min.apply(null, spans);
  const spanMax = Math.max.apply(null, spans);
  const spanAvg = Math.round(spans.reduce(function (a, b) { return a + b; }, 0) / n);

  // 和值最集中区间（按 10 为步长分桶）
  const bucketStep = Math.max(10, Math.round((sumMax - sumMin) / 8 / 10) * 10);
  const buckets = {};
  sums.forEach(function (s) {
    const base = Math.floor(s / bucketStep) * bucketStep;
    const key = base + "-" + (base + bucketStep - 1);
    buckets[key] = (buckets[key] || 0) + 1;
  });
  let sumTopKey = "";
  let sumTopCount = 0;
  Object.keys(buckets).forEach(function (k) {
    if (buckets[k] > sumTopCount) {
      sumTopKey = k;
      sumTopCount = buckets[k];
    }
  });
  const sumTopRate = Math.round((sumTopCount / n) * 100);

  // ---- 奇偶比 / 大小比 ----
  const oeMap = {};
  const bsMap = {};
  list.forEach(function (r) {
    const nums = analysis.zoneOf(r, part);
    const oe = analysis.oddEvenOf(nums);
    const bs = analysis.bigSmallOf(nums, m, part);
    oeMap[oe.odd + ":" + oe.even] = (oeMap[oe.odd + ":" + oe.even] || 0) + 1;
    bsMap[bs.big + ":" + bs.small] = (bsMap[bs.big + ":" + bs.small] || 0) + 1;
  });
  const oeTop = topOfMap(oeMap, n);
  const bsTop = topOfMap(bsMap, n);

  // ---- 连号 / 重号 ----
  let consCount = 0;
  let repCount = 0;
  for (let i = 0; i < list.length; i++) {
    const cur = analysis.zoneOf(list[i], part);
    const prev = i + 1 < list.length ? analysis.zoneOf(list[i + 1], part) : null;
    if (analysis.consecutiveGroups(cur) > 0) consCount++;
    if (prev && analysis.repeatWithPrev(prev, cur) > 0) repCount++;
  }
  const consRate = Math.round((consCount / n) * 100);
  const repRate = Math.round((repCount / n) * 100);

  // ---- 区间 / 尾数分布 ----
  const zones = analysis.zoneDistribution(list, m, part);
  const zoneTotal = n * perPeriod || 1;
  const tails = analysis.tailDistribution(list, part);

  // ---- 当前遗漏最久的号码 ----
  const byOmission = freq.list.slice().sort(function (a, b) {
    return b.omission - a.omission || a.n - b.n;
  });

  const hot = topN(freq.hot, 5);
  const cold = topN(freq.cold, 5);
  const missed = topN(byOmission, 5);

  const latestPeriod = list[0] ? list[0].period : "-";
  const oldestPeriod = list[n - 1] ? list[n - 1].period : "-";

  /* ---------------- prompt ---------------- */

  const lines = [];
  lines.push("【彩种】" + lotteryName);
  lines.push(
    "【分析对象】" + partLabel +
      "（每期 " + perPeriod + " 个，取值 " + range.min + "-" + range.max + "）"
  );
  lines.push("【统计区间】近 " + n + " 期（" + latestPeriod + " → " + oldestPeriod + "）");
  lines.push("");

  lines.push("一、号码频次");
  lines.push(
    "出现最多：" +
      hot.map(function (x) { return pad(x.n) + "(" + x.count + "次)"; }).join("  ")
  );
  lines.push(
    "出现最少：" +
      cold.map(function (x) { return pad(x.n) + "(" + x.count + "次)"; }).join("  ")
  );
  lines.push(
    "从未出现：" +
      (freq.missing.length
        ? freq.missing.map(function (x) { return pad(x.n); }).join("  ")
        : "无")
  );
  lines.push("");

  lines.push("二、当前遗漏（距上次出现过了多少期）");
  lines.push(
    "遗漏最久：" +
      missed.map(function (x) { return pad(x.n) + "(" + x.omission + "期)"; }).join("  ")
  );
  lines.push("");

  lines.push("三、和值与跨度");
  lines.push(
    "和值范围 " + sumMin + "-" + sumMax + "，均值 " + sumAvg +
      "；最集中区间 " + (sumTopKey || "-") + "（占 " + sumTopRate + "%）"
  );
  lines.push(
    "跨度范围 " + spanMin + "-" + spanMax + "，均值 " + spanAvg
  );
  lines.push("");

  lines.push("四、奇偶与大小");
  lines.push(
    "奇偶比最常见 " + (oeTop.combo || "-") + "（占 " + Math.round(oeTop.rate * 100) + "%）"
  );
  lines.push(
    "大小比最常见 " + (bsTop.combo || "-") + "（占 " + Math.round(bsTop.rate * 100) + "%）"
  );
  lines.push("");

  lines.push("五、连号与重号");
  lines.push("连号出现率 " + consRate + "%");
  lines.push("重号出现率 " + repRate + "%");
  lines.push("");

  lines.push("六、区间分布");
  lines.push(
    zones.map(function (z) {
      return z.label + "：" + z.count + " 个（" +
        Math.round((z.count / zoneTotal) * 100) + "%）";
    }).join("  ")
  );
  lines.push("");

  lines.push("七、尾数分布（0-9）");
  lines.push(
    tails.map(function (t) { return t.tail + "→" + t.count; }).join("  ")
  );
  lines.push("");

  lines.push(
    "请基于以上统计给出分析，输出格式：\n" +
      "1）一句话结论；\n" +
      "2）三到五条观察，每条必须引用上面的具体数字；\n" +
      "3）需要警惕的误区（尤其是把随机波动当成规律）。\n" +
      "不要编造上面没有的数字。"
  );

  const prompt = lines.join("\n");

  /* ---------------- 展示用指标 ---------------- */

  const stats = [
    { label: "统计期数", value: n + " 期" },
    { label: "号码个数", value: range.max - range.min + 1 + " 个" },
    { label: "最高频次", value: freq.maxCount + " 次" },
    { label: "当前最长遗漏", value: (missed[0] ? missed[0].omission : 0) + " 期" },
    { label: "平均和值", value: String(sumAvg) },
    { label: "平均跨度", value: String(spanAvg) },
    { label: "连号出现率", value: consRate + "%" },
    { label: "重号出现率", value: repRate + "%" },
  ];

  return {
    part: part,
    partLabel: partLabel,
    stats: stats,
    hot: hot.map(function (x) {
      return { n: x.n, text: pad(x.n), count: x.count };
    }),
    cold: cold.map(function (x) {
      return { n: x.n, text: pad(x.n), count: x.count };
    }),
    missing: freq.missing.map(function (x) {
      return { n: x.n, text: pad(x.n) };
    }),
    prompt: prompt,
  };
}

module.exports = {
  buildMetrics: buildMetrics,
  pad: pad,
};
