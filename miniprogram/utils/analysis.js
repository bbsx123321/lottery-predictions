/**
 * 开奖数据分析 —— 吉号分析 / 智能规律 / 选号分布 / 走势图 的算法层
 *
 * 全部是纯函数，输入是 listDraws 拿回来的历史开奖记录（期数新的在前），
 * 输出直接喂给页面渲染。不依赖云函数，切换彩种后本地重算即可。
 */

/** 取某一号码区的号码序列 */
function zoneOf(row, part) {
  if (!row) return [];
  const list = part === "extra" ? row.extras : row.numbers;
  return Array.isArray(list) ? list : [];
}

/** 按号码区把多期数据摊平成号码序列 */
function zoneRows(rows, part) {
  return (rows || []).map(function (r) {
    return zoneOf(r, part);
  });
}

/** 该区号码取值范围 */
function rangeOf(m, part) {
  if (part === "extra") return { min: m.extraMin, max: m.extraMax };
  return { min: m.mainMin, max: m.mainMax };
}

/* ---------------- 频次与遗漏 ---------------- */

/**
 * 号码频次 + 当前遗漏。
 * @param {Array} rows 历史开奖（新→旧）
 * @param {object} m 彩种元信息
 * @param {string} part 'main' | 'extra'
 */
function frequency(rows, m, part) {
  const range = rangeOf(m, part);
  const counts = {};
  for (let n = range.min; n <= range.max; n++) counts[n] = 0;

  const firstSeen = {};
  (rows || []).forEach(function (row, idx) {
    zoneOf(row, part).forEach(function (n) {
      counts[n] = (counts[n] || 0) + 1;
      if (firstSeen[n] === undefined) firstSeen[n] = idx;
    });
  });

  const total = (rows || []).length || 1;
  const list = [];
  for (let n = range.min; n <= range.max; n++) {
    const seen = firstSeen[n];
    list.push({
      n: n,
      count: counts[n] || 0,
      // 遗漏 = 距离上一次出现过了多少期；从未出现 = 总期数
      omission: seen === undefined ? total : seen,
      rate: (counts[n] || 0) / total,
    });
  }

  const maxCount = list.reduce(function (a, b) { return b.count > a ? b.count : a; }, 0);
  // 注意初值不能用 0 —— 那样 minCount 会永远是 0
  const minCount = list.reduce(
    function (a, b) { return b.count < a ? b.count : a; },
    list.length ? list[0].count : 0
  );
  const sorted = list.slice().sort(function (a, b) { return b.count - a.count || a.n - b.n; });
  const missing = list.filter(function (x) { return x.count === 0; });

  return {
    list: list,
    maxCount: maxCount,
    minCount: minCount,
    hot: sorted.slice(0, 6),
    cold: sorted.slice(-6).reverse(),
    missing: missing,
    total: total,
  };
}

/* ---------------- 基础形态 ---------------- */

/** 奇偶比，如 { odd: 4, even: 2 } */
function oddEvenOf(numbers) {
  let odd = 0;
  numbers.forEach(function (n) {
    if (n % 2 === 1) odd++;
  });
  return { odd: odd, even: numbers.length - odd };
}

/** 大小比：以号码区中值为界 */
function bigSmallOf(numbers, m, part) {
  const range = rangeOf(m, part);
  const mid = (range.min + range.max) / 2;
  let big = 0;
  numbers.forEach(function (n) {
    if (n > mid) big++;
  });
  return { big: big, small: numbers.length - big, mid: mid };
}

/** 和值 */
function sumOf(numbers) {
  return numbers.reduce(function (a, b) { return a + b; }, 0);
}

/** 跨度 = 最大号 - 最小号 */
function spanOf(numbers) {
  if (!numbers.length) return 0;
  return Math.max.apply(null, numbers) - Math.min.apply(null, numbers);
}

/** 连续号组数，例如 12,13,14 算 1 组 */
function consecutiveGroups(numbers) {
  const sorted = numbers.slice().sort(function (a, b) { return a - b; });
  let groups = 0;
  let run = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] === 1) {
      run++;
    } else {
      if (run > 0) groups++;
      run = 0;
    }
  }
  if (run > 0) groups++;
  return groups;
}

/** 与上一期重复的号码个数 */
function repeatWithPrev(prev, curr) {
  if (!prev || !curr) return 0;
  const set = {};
  prev.forEach(function (n) { set[n] = true; });
  let c = 0;
  curr.forEach(function (n) {
    if (set[n]) c++;
  });
  return c;
}

/* ---------------- 分布 ---------------- */

/** 尾数分布 0-9 */
function tailDistribution(rows, part) {
  const buckets = [];
  for (let i = 0; i < 10; i++) buckets.push({ tail: i, count: 0 });
  (rows || []).forEach(function (row) {
    zoneOf(row, part).forEach(function (n) {
      buckets[n % 10].count++;
    });
  });
  return buckets;
}

/** 区间分布：把号码区均分成三段 */
function zoneDistribution(rows, m, part) {
  const range = rangeOf(m, part);
  const span = range.max - range.min + 1;
  const step = Math.ceil(span / 3);
  const zones = [0, 1, 2].map(function (i) {
    const from = range.min + i * step;
    const to = Math.min(range.max, from + step - 1);
    return { index: i, from: from, to: to, count: 0, label: from + "-" + to };
  });
  (rows || []).forEach(function (row) {
    zoneOf(row, part).forEach(function (n) {
      for (let i = 0; i < zones.length; i++) {
        if (n >= zones[i].from && n <= zones[i].to) {
          zones[i].count++;
          break;
        }
      }
    });
  });
  return zones;
}

/* ---------------- 智能规律 ---------------- */

/** 把一组形态统计成「出现次数最多的组合」 */
function topCombo(list) {
  const map = {};
  list.forEach(function (item) {
    map[item] = (map[item] || 0) + 1;
  });
  let best = "";
  let bestCount = 0;
  Object.keys(map).forEach(function (k) {
    if (map[k] > bestCount) {
      best = k;
      bestCount = map[k];
    }
  });
  return { combo: best, count: bestCount, rate: list.length ? bestCount / list.length : 0 };
}

/**
 * 自动发现值得注意的规律。
 * @returns {Array} 每项 {key,label,value,detail,level:'hot'|'normal'|'cool'}
 */
function patterns(rows, m, part) {
  const list = rows || [];
  const n = list.length;
  if (!n) return [];

  const out = [];

  // 和值区间
  const sums = list.map(function (r) { return sumOf(zoneOf(r, part)); });
  const sumMin = Math.min.apply(null, sums);
  const sumMax = Math.max.apply(null, sums);
  const sumAvg = Math.round(sums.reduce(function (a, b) { return a + b; }, 0) / n);
  const step = Math.max(10, Math.round((sumMax - sumMin) / 8 / 10) * 10);
  const buckets = {};
  sums.forEach(function (s) {
    const key = Math.floor(s / step) * step + "-" + (Math.floor(s / step) * step + step - 1);
    buckets[key] = (buckets[key] || 0) + 1;
  });
  const sumTop = topCombo(Object.keys(buckets).map(function (k) {
    for (var i = 0; i < buckets[k]; i++) return k;
  }).join(",").split(","));
  out.push({
    key: "sum",
    label: "和值区间",
    value: sumTop.combo || "无",
    detail: "近 " + n + " 期和值落在 " + (sumMin + "-" + sumMax) + "，均值 " + sumAvg +
      "；最集中区间 " + (sumTop.combo || "-") + "（占 " + Math.round(sumTop.rate * 100) + "%）",
    level: sumTop.rate > 0.3 ? "hot" : "normal",
  });

  // 奇偶比
  const oeCombos = list.map(function (r) {
    const o = oddEvenOf(zoneOf(r, part));
    return o.odd + ":" + o.even;
  });
  const oeTop = topCombo(oeCombos);
  out.push({
    key: "oddEven",
    label: "奇偶比",
    value: oeTop.combo || "无",
    detail: "最常见组合 " + (oeTop.combo || "-") + "，出现 " + oeTop.count + " 次（" +
      Math.round(oeTop.rate * 100) + "%）",
    level: oeTop.rate > 0.3 ? "hot" : "normal",
  });

  // 大小比
  const bsCombos = list.map(function (r) {
    const b = bigSmallOf(zoneOf(r, part), m, part);
    return b.big + ":" + b.small;
  });
  const bsTop = topCombo(bsCombos);
  out.push({
    key: "bigSmall",
    label: "大小比",
    value: bsTop.combo || "无",
    detail: "最常见组合 " + (bsTop.combo || "-") + "，出现 " + bsTop.count + " 次（" +
      Math.round(bsTop.rate * 100) + "%）",
    level: bsTop.rate > 0.3 ? "hot" : "normal",
  });

  // 连号 / 重号
  const consRates = [];
  const repRates = [];
  for (let i = 0; i < list.length; i++) {
    const cur = zoneOf(list[i], part);
    const prev = i + 1 < list.length ? zoneOf(list[i + 1], part) : null;
    consRates.push(consecutiveGroups(cur) > 0 ? 1 : 0);
    repRates.push(prev ? (repeatWithPrev(prev, cur) > 0 ? 1 : 0) : 0);
  }
  const consRate = consRates.reduce(function (a, b) { return a + b; }, 0) / n;
  const repRate = repRates.reduce(function (a, b) { return a + b; }, 0) / n;
  out.push({
    key: "consecutive",
    label: "连号出现率",
    value: Math.round(consRate * 100) + "%",
    detail: "近 " + n + " 期有 " + Math.round(consRate * 100) + "% 的期开出过连号",
    level: consRate > 0.5 ? "hot" : consRate < 0.2 ? "cool" : "normal",
  });
  out.push({
    key: "repeat",
    label: "重号出现率",
    value: Math.round(repRate * 100) + "%",
    detail: "近 " + n + " 期有 " + Math.round(repRate * 100) + "% 的期与上期有重复号",
    level: repRate > 0.5 ? "hot" : repRate < 0.2 ? "cool" : "normal",
  });

  // 冷热号
  const freq = frequency(rows, m, part);
  out.push({
    key: "hot",
    label: "热号",
    value: freq.hot.slice(0, 5).map(function (x) { return x.n; }).join(" "),
    detail: "出现频次最高：" + freq.hot.slice(0, 5).map(function (x) {
      return x.n + "(" + x.count + "次)";
    }).join("、"),
    level: "hot",
  });
  out.push({
    key: "cold",
    label: "冷号",
    value: freq.cold.slice(0, 5).map(function (x) { return x.n; }).join(" "),
    detail: "出现频次最低：" + freq.cold.slice(0, 5).map(function (x) {
      return x.n + "(" + x.count + "次)";
    }).join("、"),
    level: "cool",
  });

  // 区间冷热
  const zones = zoneDistribution(rows, m, part);
  const zoneTop = zones.slice().sort(function (a, b) { return b.count - a.count; })[0];
  out.push({
    key: "zone",
    label: "区间最热",
    value: zoneTop ? zoneTop.label : "-",
    detail: zoneTop ? "区间 " + zoneTop.label + " 累计命中 " + zoneTop.count + " 个号码，占比最高" : "",
    level: "hot",
  });

  return out;
}

/* ---------------- 走势图数据 ---------------- */

/**
 * 走势图：每个号码按期出现的 0/1 序列。
 * @returns {{periods:Array, numbers:Array}} numbers 每项 {n, hits:Array<0|1>, sum:number}
 */
function trendSeries(rows, m, part) {
  const range = rangeOf(m, part);
  const periods = (rows || []).map(function (r) {
    return { period: r.period, date: r.date };
  });
  const numbers = [];
  for (let n = range.min; n <= range.max; n++) {
    const hits = (rows || []).map(function (r) {
      return zoneOf(r, part).indexOf(n) > -1 ? 1 : 0;
    });
    numbers.push({
      n: n,
      hits: hits,
      sum: hits.reduce(function (a, b) { return a + b; }, 0),
    });
  }
  return { periods: periods, numbers: numbers };
}

/** 每个号码的遗漏走势（逐期遗漏值） */
function omissionSeries(rows, m, part) {
  const range = rangeOf(m, part);
  const periods = (rows || []).map(function (r) {
    return { period: r.period, date: r.date };
  });
  const numbers = [];
  for (let n = range.min; n <= range.max; n++) {
    const miss = [];
    let counter = 0;
    for (let i = (rows || []).length - 1; i >= 0; i--) {
      if (zoneOf(rows[i], part).indexOf(n) > -1) {
        counter = 0;
      } else {
        counter++;
      }
      miss[i] = counter;
    }
    numbers.push({ n: n, miss: miss, current: miss.length ? miss[0] : 0 });
  }
  return { periods: periods, numbers: numbers };
}

module.exports = {
  zoneOf: zoneOf,
  zoneRows: zoneRows,
  rangeOf: rangeOf,
  frequency: frequency,
  oddEvenOf: oddEvenOf,
  bigSmallOf: bigSmallOf,
  sumOf: sumOf,
  spanOf: spanOf,
  consecutiveGroups: consecutiveGroups,
  repeatWithPrev: repeatWithPrev,
  tailDistribution: tailDistribution,
  zoneDistribution: zoneDistribution,
  patterns: patterns,
  trendSeries: trendSeries,
  omissionSeries: omissionSeries,
};
